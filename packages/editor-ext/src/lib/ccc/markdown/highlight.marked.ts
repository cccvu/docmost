/**
 * CCC #145 — read `==text==` back as a highlight. Fork-owned; registered in markdown/utils/marked.utils.ts.
 *
 * Turndown writes a highlight as `==text==` (Joplin's built-in `mark` rule), but marked has no such syntax, so every
 * Markdown write, import and paste kept the literal `==`. The highlight COLOR stays lossy by design (ADR 0012 §4): it
 * comes back as the default-color highlight.
 *
 * Kept narrow so ordinary text keeps its meaning:
 *  - the opening `==` must start the text or follow a space or punctuation, never a letter, digit, `_` or `=`
 *    (`a==b`, `if a==b and c==d`), checked by the tokenizer (see `charBefore`);
 *  - the text may not start or end with a space or `=` (`a == b`, `===`), and the closing `==` may not be followed by
 *    `=` or a word character;
 *  - a closing `==` inside a code span or after a backslash does not count, and code spans / fenced code never reach
 *    this at all (marked consumes them first);
 *  - the search for a closer stops at the next `==` that could open a highlight itself, so `==a ==b==` highlights `b`.
 * The text inside is parsed as inline Markdown, so `==**bold** [link](…)==` keeps its marks.
 *
 * Linear time (review of PR 754): this runs on every Markdown write, import and paste, inside the one shared conversion
 * worker. `start()` returns the next `==` and lets the tokenizer decide, so it never rescans the rest of the text; the
 * closer search ends at the next possible opener, so no two failed searches cover the same text; and the character
 * before an opener is read without copying the text so far (`charBefore`). Before, every
 * unclosed opener rescanned to the end of the paragraph: 120 KB of `==a ` took 8 s.
 */
import type { Token, Tokens } from "marked";

interface HighlightToken {
  type: "highlight";
  raw: string;
  text: string;
  tokens: Token[];
}

const WORD_OR_EQ_RE = /[\p{L}\p{N}_=]/u;
const WORD_RE = /[\p{L}\p{N}_]/u;
const SPACE_RE = /\s/;

/** Whether a highlight may open after `prev` (undefined = the start of the inline text). */
function opensAfter(prev: string | undefined): boolean {
  return prev === undefined || !WORD_OR_EQ_RE.test(prev);
}

/** Whether `src` (starting at `==`) opens a highlight: something other than a space or `=` follows. */
function opensHere(src: string): boolean {
  return src.startsWith("==") && src.length > 2 && !SPACE_RE.test(src[2]) && src[2] !== "=";
}

/**
 * Index of the closing `==` for `src` (which opens at 0), or -1. Skips escapes and code spans, and gives up at the next
 * `==` that could open a highlight (which the tokenizer then tries on its own), so each character is scanned once.
 */
function closingIndex(src: string): number {
  let i = 2;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") {
      let n = 1;
      while (src[i + n] === "`") n++;
      const run = "`".repeat(n);
      let close = src.indexOf(run, i + n);
      // a closing run must be exactly n backticks long
      while (close !== -1 && src[close + n] === "`") {
        let end = close;
        while (src[end] === "`") end++;
        close = src.indexOf(run, end);
      }
      i = close === -1 ? i + n : close + n;
      continue;
    }
    if (ch === "=" && src[i + 1] === "=") {
      let end = i;
      while (src[end] === "=") end++;
      const before = src[i - 1];
      const after = src[i + 2];
      if (end - i === 2 && i > 2 && !SPACE_RE.test(before) && before !== "=" && (after === undefined || !WORD_RE.test(after))) {
        return i;
      }
      // A run of exactly two that opens here is the tokenizer's next attempt: stop, so no text is scanned twice.
      if (end - i === 2 && opensAfter(before) && opensHere(src.slice(i, i + 3))) return -1;
      i = end;
      continue;
    }
    i++;
  }
  return -1;
}

/**
 * The source this tokenizer last saw, per inline run (marked's token array for it). marked calls the inline
 * extensions at each position of a run, always with a suffix of the same string, so the character before `src` is
 * the last one consumed since that call, read from the earlier suffix in O(1). Never read it from the previous
 * token's `raw`: marked grows a text token with `+=`, and indexing that string copies all of it on every call, which
 * made a long run quadratic.
 */
const lastSrc = new WeakMap<Token[], string>();

function charBefore(src: string, earlier: string | undefined, tokens: Token[]): string | undefined {
  if (earlier !== undefined && earlier.length > src.length) return earlier[earlier.length - src.length - 1];
  if (tokens.length === 0) return undefined; // the start of the run
  const raw = tokens[tokens.length - 1].raw; // first call on a run that already holds tokens: once per run
  return raw ? raw[raw.length - 1] : undefined;
}

export const highlightExtension = {
  name: "highlight",
  level: "inline" as const,
  // The next `==`, whether or not it opens: the tokenizer decides. Skipping non-openers here would rescan the rest of
  // the text on every call (marked calls this again after each code span, link, …), which is quadratic.
  start(src: string): number | undefined {
    const index = src.indexOf("==");
    return index === -1 ? undefined : index;
  },
  tokenizer(this: { lexer: { inlineTokens(src: string): Token[] } }, src: string, tokens: Token[]): HighlightToken | undefined {
    const earlier = lastSrc.get(tokens);
    lastSrc.set(tokens, src);
    if (!opensHere(src)) return undefined;
    if (!opensAfter(charBefore(src, earlier, tokens))) return undefined;
    const close = closingIndex(src);
    if (close === -1) return undefined;
    const text = src.slice(2, close);
    return {
      type: "highlight",
      raw: src.slice(0, close + 2),
      text,
      tokens: this.lexer.inlineTokens(text),
    };
  },
  renderer(this: { parser: { parseInline(tokens: Token[]): string } }, token: Tokens.Generic): string {
    return `<mark>${this.parser.parseInline((token as unknown as HighlightToken).tokens)}</mark>`;
  },
};
