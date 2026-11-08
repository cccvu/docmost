/**
 * #773 fitness function: the live document becomes JSON only through `storeSafeJson`.
 *
 * `TiptapTransformer.fromYdoc` is where a Y.Doc turns into page JSON, and a crafted collab client controls what that
 * JSON holds: a lone surrogate or NUL that Postgres refuses, an attribute value `JSON.stringify` throws on. The collab
 * store and the ADR 0019 digest wrap it in `storeSafeJson`, so each stores and hashes the same storable projection. A
 * new unwrapped use would bring the wedge back on whatever it writes (or hashes). This scans every non-spec server
 * source with the TypeScript AST (comments and strings do not count) and fails on a `fromYdoc` call that is not the
 * direct argument of `storeSafeJson`, or that sits outside the allowlist below.
 *
 * Run in CI via the `docmost-authz` job's jest glob (`… src/authz …`).
 */
import { readdirSync, readFileSync } from 'fs';
import { join, relative, resolve, sep } from 'path';
import * as ts from 'typescript';

const SRC_ROOT = resolve(__dirname, '..', '..');

/** Every file that may turn the live document into JSON, and how many times (paths relative to apps/server/src). */
const ALLOWED: Record<string, number> = {
  'collaboration/extensions/persistence.extension.ts': 1, // the store (UPSTREAM_MODIFICATIONS.md §122)
  'authz/page-write/doc-version.ts': 1, // the ADR 0019 content digest
};

const walk = (dir: string, out: string[]): string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!['node_modules', '__fixtures__', 'ee'].includes(entry.name)) walk(full, out);
    } else if (/\.ts$/.test(entry.name) && !/\.(spec|testkit|d)\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
};

type Use = { file: string; line: number; wrapped: boolean };

/** Every reference to a `fromYdoc` name in `text` (a call, a property access, an import, a destructure), and whether
 *  it is a call passed straight to `storeSafeJson(...)`. */
const usesIn = (file: string, text: string): Use[] => {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: Use[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'fromYdoc') {
      // The reference expression: `X.fromYdoc` or a bare `fromYdoc`.
      const ref = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node ? node.parent : node;
      const call = ts.isCallExpression(ref.parent) && ref.parent.expression === ref ? ref.parent : undefined;
      const outer = call?.parent;
      const wrapped =
        !!call &&
        !!outer &&
        ts.isCallExpression(outer) &&
        ts.isIdentifier(outer.expression) &&
        outer.expression.text === 'storeSafeJson' &&
        outer.arguments[0] === call;
      found.push({ file: relative(SRC_ROOT, file).split(sep).join('/'), line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, wrapped });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
};

describe('the live document becomes JSON only through storeSafeJson (#773)', () => {
  const uses = walk(SRC_ROOT, []).flatMap((f) => usesIn(f, readFileSync(f, 'utf8')));

  it('every fromYdoc use is in an allowlisted file, as the direct argument of storeSafeJson', () => {
    expect(uses.filter((u) => !(u.file in ALLOWED) || !u.wrapped)).toEqual([]);
  });

  it('each allowlisted file uses it exactly as often as recorded (the allowlist is not stale)', () => {
    const counts: Record<string, number> = {};
    for (const u of uses) counts[u.file] = (counts[u.file] ?? 0) + 1;
    expect(counts).toEqual(ALLOWED);
  });

  it('is not vacuous: it flags an unwrapped call, an alias and a call wrapped in something else', () => {
    const flagged = (src: string) => usesIn(join(SRC_ROOT, 'x.ts'), src).map((u) => u.wrapped);
    expect(flagged(`const j = TiptapTransformer.fromYdoc(doc, 'default');`)).toEqual([false]);
    expect(flagged(`const { fromYdoc } = TiptapTransformer; fromYdoc(doc);`)).toEqual([false, false]);
    expect(flagged(`const j = other(TiptapTransformer.fromYdoc(doc));`)).toEqual([false]);
    expect(flagged(`const j = storeSafeJson(x, TiptapTransformer.fromYdoc(doc));`)).toEqual([false]);
    expect(flagged(`const j = storeSafeJson(TiptapTransformer.fromYdoc(doc, 'default'));`)).toEqual([true]);
    expect(flagged(`// TiptapTransformer.fromYdoc(doc) in a comment\nconst s = 'fromYdoc(doc)';`)).toEqual([]);
  });
});
