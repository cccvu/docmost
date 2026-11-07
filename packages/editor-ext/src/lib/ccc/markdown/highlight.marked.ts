/**
 * CCC #145 — read `==text==` back as a highlight. Fork-owned; registered in markdown/utils/marked.utils.ts.
 *
 * Turndown writes a highlight as `==text==` (Joplin's built-in `mark` rule), but marked has no such syntax, so every
 * Markdown write, import and paste kept the literal `==`. The highlight COLOR stays lossy by design (ADR 0012 §4): it
 * comes back as the default-color highlight.
 *
 * Kept narrow so ordinary text keeps its meaning:
 *  - the opening `==` must start the text or follow a space or punctuation, never a letter, digit, `_` or `=`
 *    (`a==b`, `if a==b and c==d`), checked in `start()` AND in the tokenizer, which sees the previous token;
 *  - the text may not start or end with a space or `=` (`a == b`, `===`), and the closing `==` may not be followed by
 *    `=` or a word character;
 *  - a closing `==` inside a code span or after a backslash does not count, and code spans / fenced code never reach
 *    this at all (marked consumes them first).
 * The text inside is parsed as inline Markdown, so `==**bold** [link](…)==` keeps its marks.
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

/** Index of the closing `==` for `src` (which opens at 0), or -1. Skips escapes and code spans. */
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
      i = end;
      continue;
    }
    i++;
  }
  return -1;
}

export const highlightExtension = {
  name: "highlight",
  level: "inline" as const,
  start(src: string): number | undefined {
    let from = 0;
    for (;;) {
      const index = src.indexOf("==", from);
      if (index === -1) return undefined;
      // Index 0 has a previous character this function cannot see (marked passes the text after it): the tokenizer
      // decides there.
      if (opensHere(src.slice(index)) && (index === 0 || opensAfter(src[index - 1]))) return index;
      from = index + 1;
    }
  },
  tokenizer(this: { lexer: { inlineTokens(src: string): Token[] } }, src: string, tokens: Token[]): HighlightToken | undefined {
    if (!opensHere(src)) return undefined;
    const prevRaw = tokens.length > 0 ? tokens[tokens.length - 1].raw : "";
    if (!opensAfter(prevRaw ? prevRaw[prevRaw.length - 1] : undefined)) return undefined;
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
