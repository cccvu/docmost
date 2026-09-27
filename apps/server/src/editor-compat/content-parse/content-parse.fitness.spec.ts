/**
 * #626 fitness function: untrusted HTML/Markdown is converted ONLY inside the conversion worker.
 *
 * On the main thread these conversions have no bound (seconds to minutes of blocked event loop, or an exhausted
 * heap, for one write). `parseUntrustedContent` / `untrustedMarkdownToHtml` run them in the bounded worker; a new
 * direct use of the underlying functions anywhere else would quietly bring the unbounded cost back. This scans every
 * non-spec server source with the TypeScript AST (so comments and strings do not count) and fails on any use outside
 * the allowlist below.
 *
 * Run in CI via the `docmost-authz` job's jest glob (`… src/editor-compat …`).
 */
import { readdirSync, readFileSync } from 'fs';
import { join, relative, resolve, sep } from 'path';
import * as ts from 'typescript';

const SRC_ROOT = resolve(__dirname, '..', '..');

/** Where each conversion function may be used (paths relative to apps/server/src). */
const ALLOWED: Record<string, string[]> = {
  // The worker is the one place that runs the conversions.
  htmlToJson: ['editor-compat/content-parse/content-parse.worker.ts'],
  markdownToHtml: ['editor-compat/content-parse/content-parse.worker.ts'],
  // generateJSON is htmlToJson's own first step.
  generateJSON: ['collaboration/collaboration.util.ts'],
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

/** Every place a file uses one of the names (not its own declaration, and not an import/export specifier). */
const usesIn = (file: string): Array<{ name: string; line: number }> => {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const found: Array<{ name: string; line: number }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && Object.prototype.hasOwnProperty.call(ALLOWED, node.text)) {
      const p = node.parent;
      const declaration =
        (ts.isFunctionDeclaration(p) && p.name === node) ||
        ts.isImportSpecifier(p) ||
        ts.isExportSpecifier(p) ||
        ts.isImportClause(p);
      if (!declaration) found.push({ name: node.text, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
};

describe('#626 untrusted content is converted only in the bounded worker', () => {
  const files = walk(SRC_ROOT, []);
  const uses = files.flatMap((file) =>
    usesIn(file).map((u) => ({ ...u, file: relative(SRC_ROOT, file).split(sep).join('/') })),
  );

  it('scanned the server sources (not a silently empty walk)', () => {
    expect(files.length).toBeGreaterThan(500);
    // Each allowed use really exists, so the allowlist cannot go stale unnoticed.
    for (const [name, where] of Object.entries(ALLOWED)) {
      for (const file of where) expect(uses).toContainEqual(expect.objectContaining({ name, file }));
    }
  });

  it('no other server code calls htmlToJson, markdownToHtml or generateJSON', () => {
    const offenders = uses.filter((u) => !ALLOWED[u.name].includes(u.file)).map((u) => `${u.file}:${u.line} ${u.name}`);
    // Convert through parseUntrustedContent / untrustedMarkdownToHtml (editor-compat/content-parse) instead.
    expect(offenders).toEqual([]);
  });
});
