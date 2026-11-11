/**
 * CCC authorization integration — NOT upstream Docmost code (#781 lineage, ADR 0036 amendment).
 *
 * The load repair of legacy values: stored content written before #781 can hold attribute and mark values the guard's
 * value rules refuse today (a `colspan` of "100%" or 0, a link whose `href` is a number, a highlight `colorName` that is
 * an object, a value too deep). The guard exempts such a value only inside its ORIGINAL struct (`legacyInvalid`), but
 * an honest editor copies or derives it into new structs: prosemirror-tables' `fixTables` turns a "100%" span into
 * colspan-0 padding cells (and never converges: it grows the table on every open), and splitting a paragraph, dragging
 * a block or indenting a list re-creates the element with its attributes. Every such frame is refused, so the page
 * cannot be edited.
 *
 * So once per document lifetime, before any connection syncs (Hocuspocus 4.7.1 awaits `afterLoadDocument` before
 * `createDocument` resolves, and a connection is created only after that), every stored value the guard's OWN value
 * rules refuse (`checkAttribute` / `checkFormat`, content-rules.ts: one rule source) is removed by DELETION ONLY:
 *   - an element attribute: `removeAttribute` (its map item deleted). y-tiptap's `schema.node` then fills in the
 *     ProseMirror default (a span becomes 1), so the rendered result is the default without writing it. An attribute
 *     the schema declares as required (no default) is left alone: removing it would make y-tiptap delete the element.
 *   - a mark: its ContentFormat item deleted. Where the run before it carries a value for the same mark (it would then
 *     spill over the repaired run), `format(run, { [key]: null })` ends that mark over the run, in the same transaction.
 *     Its only new structs are format items: a null, and the negation Yjs writes back, which is the earlier run's own
 *     value (checked to pass `checkFormat` before anything is written; otherwise that run is left alone).
 * Text is never re-inserted and no attribute is set. That is load-bearing: the repair runs with `skipStoreHooks` (no
 * user is behind it, and the store reads `lastContext.user.id`), so it is persisted only by the next real store. Until
 * then every lifetime loads the same unrepaired row and repairs it again, with a new server client id: a repair that
 * wrote content would be echoed back by a browser that synced an earlier lifetime, duplicating it. Deletes of stored
 * items are the same deletes in every lifetime; a null format written by two lifetimes renders the same as one.
 *
 * What it does NOT do: client frames are still never repaired (ADR 0036: refused, never repaired), ingest still
 * refuses invalid values (ADR 0012: never normalized on ingest), and structure or schema legacy (an unknown node, a
 * table past the extent bound, a required attribute with no value) stays with the guard's audit and `legacyInvalid`.
 * It never throws out of `repairLegacyValues`'s plan, and the caller (collab-update-guard.extension.ts) catches the rest.
 */
import * as Y from 'yjs';
import { serverSchema } from '../page-write/prelim-content';
import { checkAttribute, checkFormat, isElementName, type CollabRule, type Violation } from './content-rules';

/** The value rules: what a stored value can fail on its own, as opposed to structure or schema. Only these are repaired. */
export const REPAIRABLE_RULES: ReadonlySet<CollabRule> = new Set<CollabRule>([
  'attr-kind',
  'value-depth',
  'value-size',
  'value-kind',
  'string-attr',
  'number-attr',
]);

/**
 * Hocuspocus 4.x `LocalTransactionOrigin` with `skipStoreHooks` (as reconcile-store.ts's RECONCILE_ORIGIN): `onChange`
 * still runs (the persistence extension ignores a non-connection source), no store is scheduled.
 */
export const REPAIR_ORIGIN = Object.freeze({ source: 'local' as const, skipStoreHooks: true });

/** What a repair did: counts and rule names only (logged; never a value). */
export interface LegacyRepair {
  /** Element attributes removed. */
  attrs: number;
  /** Mark (format) items deleted. */
  marks: number;
  /** Runs where a `null` format stopped the mark before them spilling over the repaired run. */
  spills: number;
  /** Values the rules refuse that were left alone (a required attribute; a spill whose earlier value fails too). */
  skipped: number;
  rules: Partial<Record<CollabRule, number>>;
}

type Plan = {
  attrs: Array<{ el: Y.XmlElement; key: string }>;
  marks: Y.Item[];
  spills: Array<{ text: Y.XmlText; at: number; length: number; key: string }>;
  report: LegacyRepair;
};

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const repairable = (v: Violation | null): v is Violation => v !== null && REPAIRABLE_RULES.has(v.rule);
const count = (report: LegacyRepair, rule: CollabRule) => {
  report.rules[rule] = (report.rules[rule] ?? 0) + 1;
};

/** Repair `doc` in place (one transaction, only when there is something to repair). */
export function repairLegacyValues(doc: Y.Doc, origin: unknown = REPAIR_ORIGIN): LegacyRepair {
  const plan = planLegacyRepair(doc);
  // A clean document runs NO transaction: each one bumps the mutation generation (doc-version.ts), which would cost a
  // digest recompute and make the next store write a row that did not change (#731).
  if (!plan.attrs.length && !plan.marks.length) return plan.report;
  Y.transact(
    doc,
    (tr) => {
      for (const { el, key } of plan.attrs) el.removeAttribute(key);
      for (const item of plan.marks) if (!item.deleted) item.delete(tr);
      // After the deletes, so Yjs computes the negation from the run before (never from the deleted value).
      for (const { text, at, length, key } of plan.spills) text.format(at, length, { [key]: null });
    },
    origin,
  );
  return plan.report;
}

/**
 * What `repairLegacyValues` would do, without a transaction (it may type an untyped root, which runs none). An iterative
 * walk over the visible tree: any depth, no recursion.
 */
export function planLegacyRepair(doc: Y.Doc): Plan {
  const report: LegacyRepair = { attrs: 0, marks: 0, spills: 0, skipped: 0, rules: {} };
  const plan: Plan = { attrs: [], marks: [], spills: [], report };
  // The persistence extension types the root on load (#731); a loader that did not leaves it an untyped AbstractType,
  // which typing here (outside any transaction) only gives its constructor. Any other type is not a page: not ours.
  const stored = doc.share.get('default');
  if (!stored || !(stored instanceof Y.XmlFragment || stored.constructor === Y.AbstractType)) return plan;
  const root = doc.getXmlFragment('default');
  const schema = serverSchema();
  const stack: Y.XmlFragment[] = [root];
  while (stack.length) {
    const type = stack.pop()!;
    const isRoot = type === root;
    if (!isRoot) planElementAttributes(type as Y.XmlElement, schema.nodes[(type as Y.XmlElement).nodeName].spec.attrs ?? {}, plan);
    for (let item = type._start; item !== null; item = item.right) {
      if (item.deleted || !(item.content instanceof Y.ContentType)) continue;
      const child = item.content.type;
      if (child.constructor === Y.XmlElement) {
        // A name the schema does not know: y-tiptap deletes the whole element on every open; not a value to repair.
        if (isElementName((child as Y.XmlElement).nodeName)) stack.push(child as Y.XmlElement);
      } else if (child.constructor === Y.XmlText && !isRoot) {
        planTextMarks(child as Y.XmlText, plan);
      }
    }
  }
  return plan;
}

function planElementAttributes(el: Y.XmlElement, specs: Record<string, unknown>, plan: Plan): void {
  for (const [key, item] of el._map) {
    if (item.deleted) continue;
    // A value that is not a plain JSON value (a nested type, a string item, ...) is `attr-kind`, as checkElement says.
    const v: Violation | null =
      item.content instanceof Y.ContentAny ? checkAttribute(el.nodeName, key, item.content.arr, { yjs: true }) : { rule: 'attr-kind' };
    if (!repairable(v)) continue;
    const spec = hasOwn(specs, key) ? (specs[key] as object | null) : undefined;
    if (spec && typeof spec === 'object' && !hasOwn(spec, 'default')) {
      plan.report.skipped++; // required with no default: removing it would make y-tiptap delete the element
      continue;
    }
    plan.attrs.push({ el, key });
    plan.report.attrs++;
    count(plan.report, v.rule);
  }
}

/**
 * One XmlText's format items, left to right. `current` is the value in effect for each key as it will be AFTER the
 * repair (a refused item is treated as already deleted). A refused item opens a "bad run" for its key, which lasts to
 * the next kept item for that key (or the end): deleting the item gives that run the value before it, so where that is
 * a mark (not null) a null format over the run ends it.
 */
function planTextMarks(text: Y.XmlText, plan: Plan): void {
  for (const [, attr] of text._map) if (!attr.deleted) return; // an XmlText with attributes: structure legacy, not ours
  const current = new Map<string, unknown>();
  const open = new Map<string, { at: number; prev: unknown; items: Y.Item[]; rules: CollabRule[] }>();
  const runs: Array<{ key: string; at: number; end: number; prev: unknown; items: Y.Item[]; rules: CollabRule[] }> = [];
  let index = 0;
  for (let item = text._start; item !== null; item = item.right) {
    if (item.deleted) continue;
    const content = item.content;
    if (content instanceof Y.ContentString) {
      index += item.length;
      continue;
    }
    if (!(content instanceof Y.ContentFormat)) return; // an embed or a type in text: structure legacy, not ours
    const v = checkFormat(content.key, content.value);
    if (repairable(v)) {
      const run = open.get(content.key);
      if (run) {
        run.items.push(item);
        run.rules.push(v.rule);
      } else {
        open.set(content.key, { at: index, prev: current.get(content.key) ?? null, items: [item], rules: [v.rule] });
      }
      continue;
    }
    const run = open.get(content.key);
    if (run) {
      runs.push({ key: content.key, end: index, ...run });
      open.delete(content.key);
    }
    current.set(content.key, content.value);
  }
  for (const [key, run] of open) runs.push({ key, end: index, ...run });

  for (const run of runs) {
    const spill = run.prev !== null && run.prev !== undefined && run.end > run.at;
    // The null format makes Yjs write the earlier value back after the run: it must pass the rules a client's would.
    if (spill && checkFormat(run.key, run.prev) !== null) {
      plan.report.skipped += run.items.length;
      continue;
    }
    plan.marks.push(...run.items);
    plan.report.marks += run.items.length;
    for (const rule of run.rules) count(plan.report, rule);
    if (spill) {
      plan.spills.push({ text, at: run.at, length: run.end - run.at, key: run.key });
      plan.report.spills++;
    }
  }
}
