/**
 * CCC integration — NOT upstream Docmost code (#773, UPSTREAM_MODIFICATIONS.md §122).
 *
 * Make the collab store's serialized page JSON storable in Postgres. Postgres refuses two code points that a JS
 * string can hold: a lone UTF-16 surrogate (half an emoji) in jsonb (22P02), and U+0000 in jsonb (22P05) and text
 * (22021). Yjs writes format (mark attribute), embed and JSON content as escaped JSON, so a lone surrogate an editor
 * client sends there survives decoding (text, keys and `ContentAny` go through UTF-8 and come back as U+FFFD); NUL
 * survives everywhere. Either one made `onStoreDocument` fail on every store of the page while it stayed open.
 *
 * Both become U+FFFD, in values and object keys: one replacement that keeps the text length and shows something was
 * replaced. Only the stored projection (`pages.content`, `text_content`, the transclusion rows) is normalized. The live
 * Y.Doc and the `pages.ydoc` bytes keep the raw value: bytea stores any byte, every later store normalizes the same
 * state to the same JSON (so it deep-equals the row and no rewrite loop starts), and the ADR 0019 digest is computed
 * from the live document on both sides of a compare, never against the row.
 *
 * Copy-on-write: a clean input comes back as the SAME reference (nothing allocated), and the input is never mutated —
 * y-prosemirror hands back Yjs's own format and attribute objects, so writing into them would edit the live document.
 * If two keys of one object normalize to the same name, the later one (in `Object.keys` order) wins.
 */
type WellFormedString = string & { isWellFormed(): boolean; toWellFormed(): string }; // Node ≥ 20; the target lib predates them

/** `s` with every lone surrogate and NUL replaced by U+FFFD; `s` itself when it holds neither. */
export function storeSafeString(s: string): string {
  if ((s as WellFormedString).isWellFormed() && !s.includes('\0')) return s;
  return (s as WellFormedString).toWellFormed().replace(/\0/g, '\uFFFD');
}

/** `value` with every string and object key made storable; `value` itself when nothing changes. Never mutates it. */
export function storeSafeJson<T>(value: T): T {
  if (typeof value === 'string') return storeSafeString(value) as T;
  if (Array.isArray(value)) {
    let out: unknown[] | undefined;
    for (let i = 0; i < value.length; i++) {
      const v = storeSafeJson(value[i]);
      if (v !== value[i]) (out ??= value.slice())[i] = v;
    }
    return (out ?? value) as T;
  }
  if (value === null || typeof value !== 'object') return value;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value; // not JSON-shaped (e.g. a Uint8Array): left as is
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  let out: Record<string, unknown> | undefined;
  for (let i = 0; i < keys.length; i++) {
    const key = storeSafeString(keys[i]);
    const v = storeSafeJson(obj[keys[i]]);
    if (!out && (key !== keys[i] || v !== obj[keys[i]])) {
      out = Object.create(proto) as Record<string, unknown>;
      for (let j = 0; j < i; j++) put(out, keys[j], obj[keys[j]]);
    }
    if (out) put(out, key, v);
  }
  return (out ?? value) as T;
}

/** An own, enumerable property — even for a `__proto__` key, which plain assignment would turn into a prototype. */
const put = (o: Record<string, unknown>, key: string, value: unknown): void => {
  Object.defineProperty(o, key, { value, enumerable: true, writable: true, configurable: true });
};
