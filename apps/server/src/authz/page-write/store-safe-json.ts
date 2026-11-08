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
 * replaced. Only the stored projection (`pages.content`, `text_content`, the transclusion rows) and the ADR 0019
 * digest (`doc-version.ts`) see the result. The live Y.Doc and the `pages.ydoc` bytes keep the raw value: bytea stores
 * any byte, and every later store normalizes the same state to the same JSON, so it deep-equals the row and no rewrite
 * loop starts.
 *
 * The walk follows what `JSON.stringify` (and so the postgres.js jsonb serializer) writes, because a crafted client
 * controls the SHAPE as well as the strings (#773 security review):
 *   - `toJSON` is called first (a `Y.Map`/`Y.Array`/`Y.Text` element attribute value, a `Date`), and its result walked;
 *   - every other object is walked by its own enumerable string keys WHATEVER its prototype — an attribute named
 *     `__proto__` re-prototypes the attrs object that Yjs builds by assignment, and lib0 `readAny` does the same to a
 *     decoded object — and an object whose prototype is not `Object.prototype` or `null` is copied into a plain one;
 *   - `undefined`, functions and symbols are dropped from an object and become `null` in an array; a non-finite
 *     number becomes `null` and `-0` becomes `0` (what the row reads back, so the no-op check still converges);
 *   - a BigInt (which Yjs carries and `JSON.stringify` throws on, wedging the store the same way) becomes its decimal
 *     string;
 *   - an `ArrayBuffer` view (a `Uint8Array` from `ContentAny`) is left as is: it holds only numbers.
 * So the result is a plain JSON value with every string storable.
 *
 * Copy-on-write: a clean, plain input comes back as the SAME reference (nothing allocated), and the input is never
 * mutated — y-prosemirror hands back Yjs's own format and attribute objects, so writing into them would edit the live
 * document. If two keys of one object normalize to the same name, the later one (in `Object.keys` order) wins.
 */
type WellFormedString = string & { isWellFormed(): boolean; toWellFormed(): string }; // Node ≥ 20; the target lib predates them

/** `s` with every lone surrogate and NUL replaced by U+FFFD; `s` itself when it holds neither. */
export function storeSafeString(s: string): string {
  if ((s as WellFormedString).isWellFormed() && !s.includes('\0')) return s;
  return (s as WellFormedString).toWellFormed().replace(/\0/g, '�');
}

/**
 * The JSON value `JSON.stringify(value)` writes, with every string and object key made storable (see above); `value`
 * itself when it is already a plain JSON value with storable strings. Never mutates it. The static type is the input's:
 * the result has the same JSON shape, not necessarily the same runtime classes.
 */
export function storeSafeJson<T>(value: T): T {
  return project(value, '') as T;
}

/** `value` as `JSON.stringify` would see it under `key`; `undefined` where it would write nothing. */
function project(input: unknown, key: string): unknown {
  let value = input;
  if (
    value !== null &&
    (typeof value === 'object' || typeof value === 'bigint') &&
    typeof (value as { toJSON?: unknown }).toJSON === 'function'
  ) {
    value = (value as { toJSON(key: string): unknown }).toJSON(key); // once, as JSON.stringify does
  }
  switch (typeof value) {
    case 'string':
      return storeSafeString(value);
    case 'number':
      return !Number.isFinite(value) ? null : Object.is(value, -0) ? 0 : value;
    case 'bigint':
      return value.toString();
    case 'boolean':
      return value;
    case 'object':
      break;
    default:
      return undefined; // undefined, a function or a symbol: not JSON
  }
  if (value === null) return null;
  if (ArrayBuffer.isView(value)) return value;
  if (Array.isArray(value)) {
    let out: unknown[] | undefined;
    for (let i = 0; i < value.length; i++) {
      const v = project(value[i], String(i)) ?? null;
      if (!Object.is(v, value[i])) (out ??= value.slice())[i] = v; // Object.is: -0 → 0 is a change
    }
    return out ?? value;
  }
  const proto = Object.getPrototypeOf(value);
  const plain = proto === Object.prototype || proto === null;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  // A non-plain object is always copied into a plain one; a plain one only once something in it changes.
  let out: Record<string, unknown> | undefined = plain ? undefined : {};
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const key = storeSafeString(k);
    const v = project(obj[k], k);
    if (!out && (v === undefined || key !== k || !Object.is(v, obj[k]))) {
      out = Object.create(proto) as Record<string, unknown>;
      for (let j = 0; j < i; j++) put(out, keys[j], obj[keys[j]]);
    }
    if (out && v !== undefined) put(out, key, v);
  }
  return out ?? value;
}

/** An own, enumerable property — even for a `__proto__` key, which plain assignment would turn into a prototype. */
const put = (o: Record<string, unknown>, key: string, value: unknown): void => {
  Object.defineProperty(o, key, { value, enumerable: true, writable: true, configurable: true });
};
