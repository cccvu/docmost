/**
 * #840 fitness function (ADR 0036, plan part 5): every load of a stored `pages.ydoc` goes through `loadStableYdoc`, so no
 * reader serves a reload-unstable row without its heal (I2). Scans every non-spec server source with the TypeScript AST
 * and fails when:
 *   - `loadStoredYdoc` (the bounded apply, compaction.ts) is called anywhere but heal-image.ts (`loadStableYdoc`);
 *   - `loadStableYdoc` is called anywhere but the persistence seam (#122), or not exactly once there;
 *   - the persistence seam applies an update other than the content-only row's conversion (`Y.applyUpdate(document,
 *     update)`): a row's ydoc applied directly bypasses the heal;
 *   - a page row is read with `includeYdoc: true` anywhere but the load's read (persistence-steps.ts) and the store's
 *     locked read for the #390 reconcile (the seam). Duplicate and import build from JSON.
 *
 * Run in CI via the `docmost-authz` job's jest glob (`… src/authz …`).
 */
import { readdirSync, readFileSync } from 'fs';
import { join, relative, resolve, sep } from 'path';
import * as ts from 'typescript';

const SRC_ROOT = resolve(__dirname, '..', '..');
const SEAM = 'collaboration/extensions/persistence.extension.ts';
const HEAL = 'authz/page-write/heal-image.ts';
const LOAD_READ = 'authz/page-write/persistence-steps.ts';

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

type Finding = { file: string; why: string };

/** The rules, over `files` (path relative to src → source text). */
function findings(files: Map<string, string>): Finding[] {
  const found: Finding[] = [];
  let stableLoads = 0;
  for (const [rel, text] of files) {
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
        if (name === 'loadStoredYdoc' && rel !== HEAL) found.push({ file: rel, why: 'calls loadStoredYdoc (not through loadStableYdoc)' });
        if (name === 'loadStableYdoc') {
          if (rel === SEAM) stableLoads++;
          else found.push({ file: rel, why: 'calls loadStableYdoc outside the persistence seam' });
        }
        if (rel === SEAM && name === 'applyUpdate') {
          const [target, update] = node.arguments;
          if (target?.getText(sf) !== 'document' || update?.getText(sf) !== 'update') {
            found.push({ file: rel, why: `applies ${node.arguments.map((a) => a.getText(sf)).join(', ')} (only the content-only conversion may)` });
          }
        }
      }
      if (ts.isPropertyAssignment(node) && node.name.getText(sf) === 'includeYdoc' && node.initializer.kind === ts.SyntaxKind.TrueKeyword) {
        if (rel !== SEAM && rel !== LOAD_READ) found.push({ file: rel, why: 'reads a page row with includeYdoc: true' });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  if (files.has(SEAM) && stableLoads !== 1) found.push({ file: SEAM, why: `calls loadStableYdoc ${stableLoads} times (expected once)` });
  return found;
}

const serverSources = (): Map<string, string> =>
  new Map(walk(SRC_ROOT, []).map((f) => [relative(SRC_ROOT, f).split(sep).join('/'), readFileSync(f, 'utf8')]));

describe('every pages.ydoc load goes through loadStableYdoc (#840)', () => {
  it('no server source breaks the rules', () => {
    expect(findings(serverSources())).toEqual([]);
  });

  it('is not vacuous: each rule flags the real seam when broken', () => {
    const real = serverSources();
    const seam = real.get(SEAM)!;
    const broken = (rel: string, text: string) => findings(new Map([...real, [rel, text]])).map((f) => f.why);
    expect(seam).toContain('await loadStableYdoc(document, pageId, dbState, this.db);');

    // the seam back to #827's direct bounded load: no heal
    expect(
      broken(SEAM, seam.replace('await loadStableYdoc(document, pageId, dbState, this.db);', 'loadStoredYdoc(document, pageId, dbState, this.db);')),
    ).toEqual(['calls loadStoredYdoc (not through loadStableYdoc)', 'calls loadStableYdoc 0 times (expected once)']);
    // the row applied as upstream did
    expect(broken(SEAM, seam.replace('await loadStableYdoc(document, pageId, dbState, this.db);', 'Y.applyUpdate(document, dbState);'))).toEqual([
      'applies document, dbState (only the content-only conversion may)',
      'calls loadStableYdoc 0 times (expected once)',
    ]);
    // another reader of the stored bytes
    expect(broken('core/page/x.ts', 'export const f = (r: any) => r.findById(id, { includeYdoc: true });')).toEqual([
      'reads a page row with includeYdoc: true',
    ]);
    expect(broken('core/page/x.ts', 'loadStableYdoc(doc, id, bytes, db);')).toEqual(['calls loadStableYdoc outside the persistence seam']);
    expect(broken('core/page/x.ts', 'loadStoredYdoc(doc, id, bytes, db);')).toEqual(['calls loadStoredYdoc (not through loadStableYdoc)']);
    // includeYdoc: false, or a property of another name, is no read of the bytes
    expect(broken('core/page/x.ts', 'r.findById(id, { includeYdoc: false, includeContent: true });')).toEqual([]);
  });
});
