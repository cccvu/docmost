/**
 * CCC integration — NOT upstream Docmost code (#731, UPSTREAM_MODIFICATIONS.md §2, ADR 0031 amendment).
 *
 * Build a content write's new nodes as Yjs PRELIMINARY types, before the live document is touched; the insert inside
 * the write's one transaction integrates them. A replace used to build a whole second Y.Doc (`TiptapTransformer.toYdoc`),
 * encode it and apply the update to the live document: a page-sized encode on the event loop before the connection
 * opened, and a page-sized decode + integrate inside the transaction. Building the types directly drops both.
 *
 * It is a port of what `toYdoc` itself does, so the result is the same Yjs content:
 *   - `Node.fromJSON` over the server schema (`prosemirrorJSONToYDoc`'s first step, which fills in the schema's default
 *     attributes and rejects unknown node and mark types — the same rejections, at the same point);
 *   - y-prosemirror 1.3.7's `createTypeFromTextOrElementNode` (sync-plugin.js, not exported): one Y.XmlElement per node
 *     with every non-null attribute except `ychange`, consecutive text nodes grouped into ONE Y.XmlText filled by
 *     `applyDelta`, a mark's attributes as the format value under the mark's name.
 * Pinned by prelim-content.parity.spec.ts against `toYdoc` itself: byte-identical updates, the same tree, the same
 * `fromYdoc` JSON and digest. A y-prosemirror bump must re-run it.
 *
 * Two deliberate differences from a build in another document, both so the LIVE document holds exactly what a document
 * decoded from its own encoding would hold (the same `fromYdoc` JSON, deep-equal and `stableHash`-equal, before and
 * after a reload — the ADR 0019 digest and the store's deep-equal no-op read it):
 *   - every attribute and format value is a fresh plain copy, as Yjs's decoder hands values back. ProseMirror shares one
 *     null-prototype attrs object across marks and nodes, and `stableHash` collapses a repeated object.
 *   - a mark type that does not exclude itself (y-prosemirror names those `<mark>--<hash>`) is refused: the server
 *     schema has none, pinned by the parity spec, so this throw is unreachable until the schema changes.
 *   - every string (text, attribute and format values, object keys) is made well-formed: a lone UTF-16 surrogate (half
 *     an emoji) becomes U+FFFD. Yjs's encoder (`TextEncoder`) does that to text and attribute values, so a decoded
 *     document never holds one; a raw insert would, and Postgres jsonb refuses its `fromYdoc` JSON on every store from
 *     then on (#731 review). A FORMAT value is written as escaped JSON, so `toYdoc`'s round trip KEEPS a lone surrogate
 *     there and poisons the page the same way; this build normalizes it too, the one place it differs from `toYdoc` in
 *     content. Pinned by the parity spec's lone-surrogate case.
 */
import * as Y from 'yjs';
import { getSchema } from '@tiptap/core';
import { Node as PMNode, type Mark, type Schema } from '@tiptap/pm/model';
import { tiptapExtensions } from '../../collaboration/collaboration.util';

let schema: Schema | undefined;

/** The server schema, built once (`toYdoc` rebuilds the same schema from the same extensions on every call). */
export function serverSchema(): Schema {
  if (!schema) schema = getSchema(tiptapExtensions);
  return schema;
}

/** A string as Yjs's decoder returns it: a lone surrogate is U+FFFD (Node ≥ 20; the target lib predates the type). */
const wellFormed = (s: string): string => (s as string & { toWellFormed(): string }).toWellFormed();

/**
 * A value as Yjs's own decoder returns an attribute (`readAny`): arrays and objects copied, plain-prototype, every
 * string and key well-formed.
 */
function asDecodedAny(value: unknown): unknown {
  if (typeof value === 'string') return wellFormed(value);
  if (Array.isArray(value)) return value.map(asDecodedAny);
  if (value !== null && typeof value === 'object' && !(value instanceof Uint8Array)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) out[wellFormed(key)] = asDecodedAny((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

/** A format value as Yjs's decoder returns it (`ContentFormat` is written as JSON), with its strings well-formed. */
const asDecodedFormat = (value: unknown): unknown => asDecodedAny(JSON.parse(JSON.stringify(value)));

function marksToAttributes(marks: readonly Mark[]): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  for (const mark of marks) {
    if (mark.type.name === 'ychange') continue;
    if (!mark.type.excludes(mark.type)) {
      throw new Error(`mark type "${mark.type.name}" overlaps itself; the preliminary build does not support it`);
    }
    attrs[mark.type.name] = asDecodedFormat(mark.attrs);
  }
  return attrs;
}

/** y-prosemirror's `normalizePNodeContent`: element children, with each run of text nodes as one array. */
function normalizedContent(node: PMNode): Array<PMNode | PMNode[]> {
  const out: Array<PMNode | PMNode[]> = [];
  let run: PMNode[] | null = null;
  node.forEach((child) => {
    if (child.isText) {
      if (!run) out.push((run = []));
      run.push(child);
    } else {
      run = null;
      out.push(child);
    }
  });
  return out;
}

function textType(nodes: PMNode[]): Y.XmlText {
  const type = new Y.XmlText();
  type.applyDelta(nodes.map((n) => ({ insert: wellFormed(n.text), attributes: marksToAttributes(n.marks) })));
  return type;
}

function elementType(node: PMNode): Y.XmlElement {
  const type = new Y.XmlElement(node.type.name);
  for (const key in node.attrs) {
    const value = node.attrs[key];
    if (value !== null && key !== 'ychange') type.setAttribute(key, asDecodedAny(value) as never);
  }
  type.insert(0, normalizedContent(node).map(toYType));
  return type;
}

const toYType = (n: PMNode | PMNode[]): Y.XmlElement | Y.XmlText => (Array.isArray(n) ? textType(n) : elementType(n));

/**
 * The top-level content of `prosemirrorJson` as preliminary Yjs types, for `fragment.insert`. Throws on content the
 * schema rejects (as `toYdoc` does), before any document is touched.
 */
export function buildPrelimContent(prosemirrorJson: unknown): Array<Y.XmlElement | Y.XmlText> {
  if (!prosemirrorJson) {
    // `toYdoc`'s own refusal of an empty document.
    throw new Error('empty or invalid document');
  }
  const root = PMNode.fromJSON(serverSchema(), prosemirrorJson as never);
  return normalizedContent(root).map(toYType);
}
