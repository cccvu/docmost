import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';

/**
 * CCC request control — NOT upstream Docmost code (#781, ADR 0036).
 *
 * Postgres refuses two code points a JS string can hold: U+0000 (jsonb 22P05, text 22021) and a lone UTF-16 surrogate
 * (jsonb 22P02; a text column silently gets U+FFFD from the driver's UTF-8 encoding). A request string carrying either
 * used to reach the database and fail there as a 500, after whatever the same request had already applied: the `/v1`
 * conditional update writes the content to the live document and only then the title. `findUnstorableText` finds one
 * anywhere in a parsed request value — string values and object keys, at any depth — so the request can be refused
 * before its handler runs, with nothing applied. Every other character (an emoji's surrogate PAIR, other control
 * characters) is storable and passes.
 *
 * The walk uses an explicit stack, never recursion, so a body nested 100k deep (`JSON.parse` builds one happily) is
 * walked to the bottom. It visits at most `maxValues` values: past that the answer is `too_complex` and the caller
 * refuses (fail closed, never a partial pass). Fastify's 1 MiB body limit keeps every real body under the budget (each
 * value costs at least one byte of JSON, and the deepest shape `[[[…]]]` two). Only plain objects and arrays are walked:
 * `JSON.parse` makes nothing else, and a Buffer or stream (a multipart part) is not text.
 */
export const STORABLE_TEXT_MAX_VALUES = 1_000_000;

/** The reported path is capped (a 100k-deep body has a 400 KB path); it is for the caller's eyes only. */
const MAX_PATH_CHARS = 256;

type WellFormedString = string & { isWellFormed(): boolean }; // Node ≥ 20; the target lib predates it

/** Neither a NUL nor a lone surrogate: what Postgres stores in text and jsonb alike. */
export function isStorableString(s: string): boolean {
  return (s as WellFormedString).isWellFormed() && !s.includes('\0');
}

export type UnstorableFinding = { kind: 'invalid'; path: string } | { kind: 'too_complex' };

/** One container still to walk, and how to name it: its key under its parent frame. */
interface Frame {
  readonly value: unknown;
  readonly key: string | number | undefined;
  readonly parent: Frame | undefined;
}

const isPlainContainer = (v: unknown): v is Record<string, unknown> | unknown[] => {
  if (v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return true;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/** `a.b[2].c` from the frames (built only once a finding is made), capped, with unstorable characters shown as U+FFFD. */
function pathOf(frame: Frame | undefined, last: string | number | undefined): string {
  const segments: Array<string | number> = last === undefined ? [] : [last];
  for (let f = frame; f && f.key !== undefined; f = f.parent) segments.push(f.key);
  let path = '';
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i];
    path += typeof s === 'number' ? `[${s}]` : path === '' ? s : `.${s}`;
    if (path.length > MAX_PATH_CHARS) break;
  }
  const safe = (path as WellFormedString & { toWellFormed(): string }).toWellFormed().replace(/\0/g, '�');
  return safe.length > MAX_PATH_CHARS ? `${safe.slice(0, MAX_PATH_CHARS - 1)}…` : safe;
}

/**
 * The first NUL or lone surrogate in `value` (a string value or an object key) and where it is; `null` when there is
 * none; `too_complex` when `value` holds more than `maxValues` values.
 */
export function findUnstorableText(
  value: unknown,
  maxValues: number = STORABLE_TEXT_MAX_VALUES,
): UnstorableFinding | null {
  if (typeof value === 'string') return isStorableString(value) ? null : { kind: 'invalid', path: '' };
  if (!isPlainContainer(value)) return null;
  let visited = 1;
  const stack: Frame[] = [{ value, key: undefined, parent: undefined }];
  while (stack.length > 0) {
    const frame = stack.pop() as Frame;
    const container = frame.value as Record<string, unknown> | unknown[];
    if (Array.isArray(container)) {
      for (let i = 0; i < container.length; i++) {
        if (++visited > maxValues) return { kind: 'too_complex' };
        const v = container[i];
        if (typeof v === 'string') {
          if (!isStorableString(v)) return { kind: 'invalid', path: pathOf(frame, i) };
        } else if (isPlainContainer(v)) {
          stack.push({ value: v, key: i, parent: frame });
        }
      }
      continue;
    }
    for (const k of Object.keys(container)) {
      if (++visited > maxValues) return { kind: 'too_complex' };
      if (!isStorableString(k)) return { kind: 'invalid', path: pathOf(frame, k) };
      const v = container[k];
      if (typeof v === 'string') {
        if (!isStorableString(v)) return { kind: 'invalid', path: pathOf(frame, k) };
      } else if (isPlainContainer(v)) {
        stack.push({ value: v, key: k, parent: frame });
      }
    }
  }
  return null;
}

/** `application/json`, or any `…+json` type (`application/scim+json`), with or without parameters. */
export function isJsonContentType(contentType: string | undefined): boolean {
  return typeof contentType === 'string' && /^\s*application\/(?:[a-z0-9!#$&^_.-]+\+)?json\s*(?:;|$)/i.test(contentType);
}

export const INVALID_CHARACTERS_MESSAGE =
  'The request contains a NUL character (U+0000) or an unpaired UTF-16 surrogate, which cannot be stored. Remove or replace it and send the request again.';

/** 400 `invalid_characters`: never echoes the value; `field` (when known) names where it is in the request. */
export class InvalidCharactersException extends BadRequestException {
  constructor(field?: string) {
    super({ message: INVALID_CHARACTERS_MESSAGE, code: 'invalid_characters', ...(field !== undefined ? { field } : {}) });
  }
}

/** 413 `request_too_complex`: more values than the walk's budget (unreachable under the default body limit). */
export class RequestTooComplexException extends PayloadTooLargeException {
  constructor() {
    super({ message: 'The request body holds too many values to be checked.', code: 'request_too_complex' });
  }
}
