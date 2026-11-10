/**
 * CCC authorization integration — NOT upstream Docmost code (#781, ADR 0036).
 *
 * The content rules every collaborative write is held to, shared by the collab update guard (update-guard.ts, which
 * reads a Yjs replica) and its HTTP twin (`assertCollabSafeContent`, which reads ProseMirror JSON).
 *
 * The acceptance test is the editor schema itself. Every browser renders the shared document with @tiptap/y-tiptap
 * 3.0.5, and when its `createNodeFromYElement` / `createTextNodesFromYText` cannot build a node (`schema.node` =
 * `NodeType.createChecked`, `schema.text` + `schema.mark`) it DELETES the offending Yjs element or text from the shared
 * document, and that delete syncs to everyone (upstream y-prosemirror policy). `checkElement` runs exactly those checks
 * through ProseMirror's public schema API, so "accepted" means "no browser's y-tiptap deletes anything because of it":
 *   - the children as y-tiptap maps them (an XmlElement is a node of its name; an XmlText is one text node per delta run,
 *     adjacent runs with the same marks merged as `Fragment.from` merges them), matched with `contentMatch.matchType`
 *     and `validEnd`;
 *   - each run's marks (`schema.mark(<unhashed key>, value)`, then the parent's `allowsMarks`);
 *   - the attributes (`NodeType.create`, which computes them the way `createChecked` does).
 * The few things the schema cannot say are hand-kept here and pinned by schema-names.spec.ts: exact Yjs content kinds
 * (only XmlElement/XmlText children, which the server's `fromYdoc` and y-tiptap's root conversion require),
 * STRING_ATTRS (attributes a renderer calls a string method on), and depth/size bounds that keep every recursive walker
 * (lib0's encoder, `fromYdoc`, `isDeepStrictEqual`, `stableStringify`) inside the stack.
 */
import { BadRequestException } from '@nestjs/common';
import { Mark, Node as PMNode, type MarkType, type NodeType } from '@tiptap/pm/model';
import * as Y from 'yjs';
import { jsonToNode } from '../../collaboration/collaboration.util';
import { ContentTooComplexException } from '../../editor-compat/content-parse/content-parse.service';
import { serverSchema } from '../page-write/prelim-content';

/**
 * Value depth 16 and 10k entries (the editor's deepest honest value is depth 2, a mark's attrs holding an array), and
 * element depth 128 (lists nest a few levels; the recursive walkers break between ~1k and ~7k levels). A table at most
 * 1000 columns wide (HTML's own colspan limit), 2500 rows, and 50,000 columns × rows: prosemirror-tables builds a
 * width × rows map, its `fixTables` (every editor's table plugin) pads every short row to the full width, its
 * `findWidth` is quadratic in rows once a cell spans rows, and the table view builds one `<col>` per column. Each
 * bound is well above an honest wiki table and keeps those costs to milliseconds per change.
 */
export const COLLAB_LIMITS = Object.freeze({
  valueDepth: 16,
  valueEntries: 10_000,
  elementDepth: 128,
  tableWidth: 1000,
  tableRows: 2500,
  tableCells: 50_000,
});

/**
 * Attributes a renderer reads as a string (`.startsWith`, `.trim`, `.toLowerCase`, a URL sanitizer, a React child):
 * a non-string value crashes every viewer of the page. The render-gate spec's KNOWN_THROWS (server renderers) plus the
 * client crash sites (link/media/attachment views, getFileUrl, normalizeUrl, callout/math/mention/status views).
 * Each must be a string, null or undefined. A new attribute read as a string is added here (schema-names.spec.ts).
 */
export const STRING_ATTRS: ReadonlySet<string> = new Set([
  'mark link.href',
  'mark highlight.colorName',
  'node tableCell.backgroundColorName',
  'node tableHeader.backgroundColorName',
  'node image.src',
  'node video.src',
  'node audio.src',
  'node pdf.src',
  'node pdf.name',
  'node embed.src',
  'node embed.provider',
  'node youtube.src',
  'node drawio.src',
  'node excalidraw.src',
  'node attachment.url',
  'node attachment.name',
  'node callout.icon',
  'node mathInline.text',
  'node mathBlock.text',
  'node mention.label',
  'node status.text',
]);

/**
 * Integer attributes a renderer loops over: prosemirror-tables' `computeMap` and the table node view build one column per
 * unit of `colspan`, so `colspan: 1e9` hangs every viewer's tab. Each must be an integer in its range (HTML's own limits:
 * a browser clamps `colspan` to 1000 and `rowspan` to 65534), null or undefined.
 */
export const INT_ATTRS: ReadonlyMap<string, readonly [min: number, max: number]> = new Map([
  ['node tableCell.colspan', [1, 1000]],
  ['node tableHeader.colspan', [1, 1000]],
  ['node tableCell.rowspan', [1, 65534]],
  ['node tableHeader.rowspan', [1, 65534]],
]);

export type CollabRule =
  | 'root'
  | 'content-kind'
  | 'child-kind'
  | 'text-kind'
  | 'attr-kind'
  | 'value-depth'
  | 'value-size'
  | 'value-kind'
  | 'element-depth'
  | 'string-attr'
  | 'number-attr'
  | 'table-size'
  | 'unknown-mark'
  | 'hashed-mark'
  | 'zero-length'
  | 'schema'
  | 'foreign-client'
  | 'stateless'
  | 'sync-rate'
  | 'awareness'
  | 'auth'
  | 'message-type'
  | 'undecodable'
  | 'unresolved'
  | 'internal'
  | 'shadow-unavailable';

/** A refusal. `node`/`mark`/`key` are set only to names the schema declares: a log or a response never echoes input. */
export interface Violation {
  rule: CollabRule;
  node?: string;
  mark?: string;
  key?: string;
}

/** `ok`, or the first violation; `empty` marks a failure that is only missing required content with no children. */
export interface ElementCheck {
  ok: boolean;
  violation?: Violation;
  empty?: boolean;
}

const OK: ElementCheck = { ok: true };
const fail = (violation: Violation): ElementCheck => ({ ok: false, violation, empty: false });
/** The attribute names a node or mark type declares (`spec.attrs`, what tiptap compiled into the schema). */
export const attrNames = (type: NodeType | MarkType): string[] => Object.keys(type.spec.attrs ?? {});
const own = <T>(o: Record<string, T>, k: string): T | undefined => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const knownNode = (name: string): NodeType | undefined => own(serverSchema().nodes, name);
const knownMark = (name: string): MarkType | undefined => own(serverSchema().marks, name);
const nodeId = (name: string | undefined) => (name && knownNode(name) ? name : undefined);

/** A name y-tiptap can build an element of: a schema node that is neither text nor the document itself. */
export function isElementName(name: string): boolean {
  const type = knownNode(name);
  return !!type && !type.isText && type !== serverSchema().topNodeType;
}
const isStringish = (v: unknown) => v === null || v === undefined || typeof v === 'string';

/** y-tiptap's `hashedMarkNameRegex`: `bold--AbCd1234` is the key of an overlapping mark named `bold`. */
const HASHED = /(.*)(--[a-zA-Z0-9+/=]{8})$/;
export const markNameOf = (key: string): string => HASHED.exec(key)?.[1] ?? key;

/**
 * A value's depth, size and kinds, iteratively (a format value decodes with `JSON.parse`, which nests 100k deep without
 * complaint; every later walker recurses). Only JSON-shaped data passes: no binary, no BigInt (JSON.stringify throws on
 * one), and no object whose prototype was rewritten (lib0's `readAny` assigns keys, so a `__proto__` key re-prototypes
 * the object and its keys then leak into every `value[name]` read).
 */
export function checkValue(value: unknown): CollabRule | null {
  const stack: Array<[unknown, number]> = [[value, 0]];
  let entries = 0;
  while (stack.length) {
    const [v, depth] = stack.pop()!;
    if (++entries > COLLAB_LIMITS.valueEntries) return 'value-size';
    if (v === null || v === undefined || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') continue;
    if (typeof v !== 'object') return 'value-kind';
    if (depth + 1 > COLLAB_LIMITS.valueDepth) return 'value-depth';
    if (Array.isArray(v)) {
      for (const x of v) stack.push([x, depth + 1]);
      continue;
    }
    // A plain object's prototype is a root prototype (`Object.prototype` of whichever realm made it: a worker's result
    // is made in another). A rewritten one has a longer chain; so do Date, Map, typed arrays and class instances.
    const proto = Object.getPrototypeOf(v);
    if (proto !== null && Object.getPrototypeOf(proto) !== null) return 'value-kind';
    for (const k of Object.keys(v)) stack.push([(v as Record<string, unknown>)[k], depth + 1]);
  }
  return null;
}

/**
 * A text format (Yjs `ContentFormat`, or a JSON mark): `key` is the mark name (possibly hashed), `value` its attrs.
 * A null value only ends a mark (Yjs writes one for every key active at the cursor), so it is checked first.
 */
export function checkFormat(key: string, value: unknown): Violation | null {
  if (value === null) return null;
  const name = markNameOf(key);
  const type = knownMark(name);
  if (!type) return { rule: 'unknown-mark' };
  // Every mark of this schema excludes itself (schema-names.spec.ts), so an honest client never writes a hashed key;
  // one beside the plain key would plant a duplicate mark no honest editor makes (ProseMirror's `.check()` refuses it).
  if (name !== key && type.excludes(type)) return { rule: 'hashed-mark', mark: name };
  const v = checkValue(value);
  if (v) return { rule: v, mark: name };
  if (value && typeof value === 'object') {
    for (const attr of attrNames(type)) {
      if (STRING_ATTRS.has(`mark ${name}.${attr}`) && !isStringish((value as Record<string, unknown>)[attr])) {
        return { rule: 'string-attr', mark: name, key: attr };
      }
    }
  }
  try {
    type.create(value as never); // `schema.mark(name, value)`, what y-tiptap's attributesToMarks calls
  } catch {
    return { rule: 'schema', mark: name };
  }
  return null;
}

/**
 * A null attribute value in the Yjs document: y-tiptap never writes one (it removes the attribute instead), and the
 * renderer then sees `null` where the schema default is a string or a number (`node.attrs.text.trim()` on a math node
 * crashes). So in a Yjs element null is accepted only where the attribute's schema default is itself null or absent.
 * ProseMirror JSON may carry null anywhere: `toYdoc` drops it, and the default applies.
 */
function nullAllowed(nodeName: string, key: string, yjs: boolean): boolean {
  if (!yjs) return true;
  const spec = knownNode(nodeName)?.spec.attrs?.[key] as { default?: unknown } | undefined;
  return spec?.default === null || spec?.default === undefined;
}

/** An element attribute: every value of its ContentAny (a map entry may hold several), its string-ness and its range. */
export function checkAttribute(nodeName: string, key: string, values: readonly unknown[], opts: { yjs?: boolean } = {}): Violation | null {
  const node = nodeId(nodeName);
  const attrKey = node && attrNames(knownNode(node)!).includes(key) ? key : undefined;
  if (key === '__proto__') return { rule: 'attr-kind', node }; // Yjs builds attrs by assignment: it would re-prototype them
  for (const value of values) {
    const v = checkValue(value);
    if (v) return { rule: v, node, key: attrKey };
  }
  const last = values[values.length - 1];
  const entry = `node ${nodeName}.${key}`;
  if (last === undefined || (last === null && nullAllowed(nodeName, key, !!opts.yjs))) return null;
  if (STRING_ATTRS.has(entry) && typeof last !== 'string') return { rule: 'string-attr', node, key: attrKey };
  const range = INT_ATTRS.get(entry);
  if (range && !(Number.isInteger(last) && (last as number) >= range[0] && (last as number) <= range[1])) {
    return { rule: 'number-attr', node, key: attrKey };
  }
  return null;
}

/**
 * Would y-tiptap build this element (or, for the root `'default'` fragment, the document) without deleting anything?
 * Shallow, like y-tiptap's own check: child ELEMENTS count by their type only (each is checked when it is touched).
 * `empty` marks a failure that is only "required content is missing and there is none": y-tiptap then deletes an
 * element that holds nothing, which loses nothing (the guard allows it; schema-names.spec.ts proves no cascade).
 * `gone`: children to treat as already deleted (the build audit's model of y-tiptap's cascade over legacy content).
 */
export function checkElement(type: Y.XmlElement | Y.XmlFragment, gone?: ReadonlySet<Y.AbstractType<any>>): ElementCheck {
  const schema = serverSchema();
  const isRoot = type._item === null;
  let nodeType: NodeType;
  let name: string | undefined;
  if (isRoot) {
    nodeType = schema.topNodeType;
  } else {
    if (type.constructor !== Y.XmlElement) return fail({ rule: 'child-kind' });
    name = (type as Y.XmlElement).nodeName;
    if (!isElementName(name)) return fail({ rule: 'schema' });
    nodeType = knownNode(name)!;
  }

  const attrs: Record<string, unknown> = Object.create(null);
  for (const [key, item] of type._map) {
    if (item.deleted) continue;
    if (isRoot || !(item.content instanceof Y.ContentAny)) return fail({ rule: 'attr-kind', node: name });
    const values = item.content.arr;
    const v = checkAttribute(name!, key, values, { yjs: true });
    if (v) return fail(v);
    attrs[key] = values[values.length - 1];
  }
  if (!isRoot) {
    try {
      nodeType.create(attrs); // computes the attrs as createChecked does (a required attr with no value throws)
    } catch {
      return fail({ rule: 'schema', node: name });
    }
  }

  let match = nodeType.contentMatch;
  let children = 0;
  let lastText: readonly Mark[] | null = null;
  for (let item = type._start; item !== null; item = item.right) {
    if (item.deleted) continue;
    if (gone && item.content instanceof Y.ContentType && gone.has(item.content.type)) continue; // y-tiptap deletes it
    if (!(item.content instanceof Y.ContentType)) return fail({ rule: 'child-kind', node: name });
    const child = item.content.type;
    if (child.constructor === Y.XmlElement) {
      const childName = (child as Y.XmlElement).nodeName;
      if (!isElementName(childName)) return fail({ rule: 'schema', node: name });
      match = match.matchType(knownNode(childName)!);
      if (!match) return fail({ rule: 'schema', node: name });
      children++;
      lastText = null;
      continue;
    }
    // The root conversion hands every child to createNodeFromYElement: any XmlText there throws (the page won't open).
    if (child.constructor !== Y.XmlText || isRoot) return fail({ rule: 'child-kind', node: name });
    const text = child as Y.XmlText;
    for (const [, attr] of text._map) if (!attr.deleted) return fail({ rule: 'attr-kind', node: name });
    for (let t = text._start; t !== null; t = t.right) {
      if (!t.deleted && !(t.content instanceof Y.ContentString || t.content instanceof Y.ContentFormat)) {
        return fail({ rule: 'text-kind', node: name });
      }
    }
    for (const op of text.toDelta() as Array<{ insert: unknown; attributes?: Record<string, unknown> }>) {
      if (typeof op.insert !== 'string') return fail({ rule: 'text-kind', node: name });
      const marks: Mark[] = [];
      // `for…in`, as y-tiptap's attributesToMarks iterates: it also sees keys a re-prototyped object inherits.
      for (const key in op.attributes ?? {}) {
        const value = op.attributes![key];
        const v = checkFormat(key, value);
        if (v) return fail(v);
        marks.push(schema.marks[markNameOf(key)].create(value as never));
      }
      if (!nodeType.allowsMarks(marks)) return fail({ rule: 'schema', node: name });
      const set = Mark.setFrom(marks);
      if (lastText && Mark.sameSet(lastText, set)) continue; // merged into the previous text node
      match = match.matchType(schema.nodes.text);
      if (!match) return fail({ rule: 'schema', node: name });
      children++;
      lastText = set;
    }
  }
  if (!match.validEnd) return { ok: false, violation: { rule: 'schema', node: name }, empty: children === 0 };
  return OK;
}

/** 400: content the editor schema forbids. Deterministic: fix the content, never retry it unchanged. */
export class ContentNotAllowedException extends BadRequestException {
  constructor(readonly violation: Violation) {
    const where = [violation.node && `node ${violation.node}`, violation.mark && `mark ${violation.mark}`, violation.key && `attribute ${violation.key}`]
      .filter(Boolean)
      .join(', ');
    super({
      message: `The content breaks the editor schema (${violation.rule}${where ? `: ${where}` : ''}), so it was not applied.`,
      code: 'content_not_allowed',
      rule: violation.rule,
      ...(violation.node ? { node: violation.node } : {}),
      ...(violation.mark ? { mark: violation.mark } : {}),
      ...(violation.key ? { attribute: violation.key } : {}),
    });
  }
}

/** The rules a collab frame is held to, over ProseMirror JSON, iteratively (no recursion before the depth is known). */
function walkJson(json: unknown): Violation | null {
  const stack: Array<[unknown, number]> = [[json, 0]];
  while (stack.length) {
    const [node, depth] = stack.pop()!;
    if (!node || typeof node !== 'object') continue;
    if (depth > COLLAB_LIMITS.elementDepth) return { rule: 'element-depth' };
    const { type, attrs, marks, content } = node as { type?: unknown; attrs?: unknown; marks?: unknown; content?: unknown };
    const name = typeof type === 'string' ? type : '';
    if (attrs && typeof attrs === 'object') {
      for (const key of Object.keys(attrs)) {
        const v = checkAttribute(name, key, [(attrs as Record<string, unknown>)[key]]);
        if (v) return v;
      }
    }
    if (Array.isArray(marks)) {
      for (const mark of marks) {
        if (!mark || typeof mark !== 'object' || typeof (mark as { type?: unknown }).type !== 'string') continue;
        const v = checkFormat((mark as { type: string }).type, (mark as { attrs?: unknown }).attrs ?? {});
        if (v) return v;
      }
    }
    if (Array.isArray(content)) for (const child of content) stack.push([child, depth + 1]);
  }
  return null;
}

/**
 * The HTTP twin of the collab guard: `/v1`, MCP, imports and the conditional write store JSON, which used to pass only
 * `Node.fromJSON` (no structure check, no attribute types), so every browser then silently deleted what the schema
 * forbids. Refuses element depth beyond the bound as 422 `content_too_complex` (ADR 0031's refusal), anything else as
 * 400 `content_not_allowed`. Returns the built node.
 *
 * The structure rule is y-tiptap's, the same one `checkElement` applies to a collab frame, NOT `Node.check()`: every
 * node's children match its content expression (`matchFragment` + `validEnd`, over the Fragment, whose adjacent
 * same-mark text nodes are merged as y-tiptap's are), and every child's marks are allowed by its parent. Two parts of
 * `.check()` are deliberately left out, because y-tiptap deletes nothing for them, so refusing them would only refuse a
 * `/v1` read-modify-write of content honest collaborative editing produces: mutually exclusive marks on one text (two
 * people applying `code` and `bold` to the same word at once) and an empty container whose schema needs content (two
 * concurrent deletes; y-tiptap drops the empty element, losing nothing).
 *
 * `strict` (the preliminary-content build): `Node.fromJSON` exactly as `toYdoc` runs it, its errors (an unknown node or
 * mark type) passed on as they were. Otherwise (the page parse, which has already run upstream's `jsonToNode`): an
 * unknown node type keeps upstream's behaviour, stripped by `jsonToNode` rather than refused.
 */
export function assertCollabSafeContent(json: unknown, opts: { strict?: boolean } = {}): PMNode {
  // A page's content is a document. Any other root stores its children at the Yjs root (a paragraph's text becomes a
  // root XmlText), which no browser can open; a collab frame doing the same is refused `child-kind`.
  if (!json || typeof json !== 'object' || (json as { type?: unknown }).type !== serverSchema().topNodeType.name) {
    throw new ContentNotAllowedException({ rule: 'schema' });
  }
  const v = walkJson(json);
  if (v?.rule === 'element-depth') throw new ContentTooComplexException();
  if (v) throw new ContentNotAllowedException(v);
  let node: PMNode;
  if (opts.strict) {
    node = PMNode.fromJSON(serverSchema(), json as never);
  } else {
    try {
      node = PMNode.fromJSON(serverSchema(), json as never);
    } catch (err) {
      if (!(err instanceof RangeError && err.message.includes('Unknown node type'))) throw new ContentNotAllowedException({ rule: 'schema' });
      node = jsonToNode(json as never);
    }
  }
  const violation = checkTree(node);
  if (violation) throw new ContentNotAllowedException(violation);
  return node;
}

/**
 * A span as the stored table will hold it, for the extent bound: a number-like value of at least 1, else 1. A null or
 * absent span is the default 1 (`toYdoc` and y-tiptap drop a null attribute, so it renders as 1); a span below 1 (a
 * legacy 0) is counted as 1 too, which can only over-count, never let a wider table through.
 */
const spanOf = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 1 ? n : 1;
};

/**
 * A table's width as prosemirror-tables' `findWidth` computes it (the widest row, counting cells carried down by an
 * earlier row's rowspan) and its height, in one pass; refused past COLLAB_LIMITS. `rows` holds each row's cells' spans.
 */
export function checkTableExtent(rows: ReadonlyArray<ReadonlyArray<{ colspan: unknown; rowspan: unknown }>>): Violation | null {
  if (rows.length > COLLAB_LIMITS.tableRows) return { rule: 'table-size', node: 'table' };
  let width = 0;
  let carried = 0;
  const expires = new Map<number, number>();
  for (let r = 0; r < rows.length; r++) {
    carried -= expires.get(r) ?? 0;
    let rowWidth = carried;
    for (const cell of rows[r]) {
      const colspan = spanOf(cell.colspan);
      const rowspan = spanOf(cell.rowspan);
      rowWidth += colspan;
      if (rowspan > 1) {
        carried += colspan;
        expires.set(r + rowspan, (expires.get(r + rowspan) ?? 0) + colspan);
      }
    }
    if (rowWidth > width) width = rowWidth;
    if (width > COLLAB_LIMITS.tableWidth) return { rule: 'table-size', node: 'table' };
  }
  return width * rows.length > COLLAB_LIMITS.tableCells ? { rule: 'table-size', node: 'table' } : null;
}

/** The extent of a Yjs `table` element (its visible rows and their cells' current span attributes). */
export function checkYTable(table: Y.XmlElement): Violation | null {
  const rows = (table.toArray().filter((r) => r instanceof Y.XmlElement) as Y.XmlElement[]).map((row) =>
    (row.toArray().filter((c) => c instanceof Y.XmlElement) as Y.XmlElement[]).map((cell) => ({
      colspan: cell.getAttribute('colspan'),
      rowspan: cell.getAttribute('rowspan'),
    })),
  );
  return checkTableExtent(rows);
}

/** `checkElement`'s structure rule over a built ProseMirror tree, iteratively (see `assertCollabSafeContent`). */
function checkTree(root: PMNode): Violation | null {
  const stack: PMNode[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.isText) continue;
    if (node.type.name === 'table') {
      const rows: Array<Array<{ colspan: unknown; rowspan: unknown }>> = [];
      node.forEach((row) => {
        const cells: Array<{ colspan: unknown; rowspan: unknown }> = [];
        row.forEach((cell) => cells.push({ colspan: cell.attrs.colspan, rowspan: cell.attrs.rowspan }));
        rows.push(cells);
      });
      const v = checkTableExtent(rows);
      if (v) return v;
    }
    const match = node.type.contentMatch.matchFragment(node.content);
    if ((!match || !match.validEnd) && node.childCount > 0) return { rule: 'schema', node: nodeId(node.type.name) };
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!node.type.allowsMarks(child.marks)) return { rule: 'schema', node: nodeId(node.type.name) };
      stack.push(child);
    }
  }
  return null;
}
