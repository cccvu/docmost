/**
 * #793 fitness function (ADR 0036 #793 amendment): binding-seal.ts is the only writer of `ccc_collab_binding_seal`. A
 * second writer could seal a lifetime that never committed a clean unload, or skip the claim's `lifetime_id` barrier,
 * and a seal restored from it would lock honest relays out. Scans the SQL text (string and template literals, never
 * comments) of every non-spec server source with the TypeScript AST and fails when:
 *   - the table is named anywhere but binding-seal.ts and the installer (heal-image.installer.ts);
 *   - the installer names it in anything but its `create table if not exists`;
 *   - the seal statements (`claimSealRow`, `commitSealRow`, `deleteSealInTransaction`) are called outside binding-seal.ts,
 *     the heal store (heal-image.ts) and compaction's swap (compaction.ts).
 *
 * Run in CI via the `docmost-authz` job's jest glob (`… src/authz …`).
 */
import { readdirSync, readFileSync } from 'fs';
import { join, relative, resolve, sep } from 'path';
import * as ts from 'typescript';

const SRC_ROOT = resolve(__dirname, '..', '..');
const TABLE = 'ccc_collab_binding_seal';
const SEAL = 'authz/page-write/binding-seal.ts';
const INSTALLER = 'authz/page-write/heal-image.installer.ts';
const CALLERS: Record<string, readonly string[]> = {
  claimSealRow: [SEAL, 'authz/page-write/heal-image.ts'],
  commitSealRow: [SEAL, 'authz/page-write/heal-image.ts'],
  deleteSealInTransaction: [SEAL, 'authz/page-write/compaction.ts'],
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

type Finding = { file: string; why: string };

/** The text of a string or template literal (a template's static parts, joined). */
function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' ');
  return null;
}

function findings(files: Map<string, string>): Finding[] {
  const found: Finding[] = [];
  for (const [rel, text] of files) {
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      const literal = literalText(node);
      if (literal !== null && literal.includes(TABLE)) {
        if (rel === INSTALLER) {
          const sqlText = literal.replace(/\s+/g, ' ').trim().toLowerCase();
          if (!sqlText.startsWith(`create table if not exists ${TABLE} (`)) found.push({ file: rel, why: `names ${TABLE} outside its create table` });
        } else if (rel !== SEAL) {
          found.push({ file: rel, why: `names ${TABLE} (binding-seal.ts is its only writer)` });
        }
        return; // a template's spans are inside it
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
        const allowed = Object.prototype.hasOwnProperty.call(CALLERS, name) ? CALLERS[name] : undefined;
        if (allowed && !allowed.includes(rel)) found.push({ file: rel, why: `calls ${name}` });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found;
}

const serverSources = (): Map<string, string> =>
  new Map(walk(SRC_ROOT, []).map((f) => [relative(SRC_ROOT, f).split(sep).join('/'), readFileSync(f, 'utf8')]));

describe(`binding-seal.ts is the only writer of ${TABLE} (#793)`, () => {
  it('no server source breaks the rules', () => {
    expect(findings(serverSources())).toEqual([]);
  });

  it('is not vacuous: the real files name the table and call the statements', () => {
    const real = serverSources();
    expect(real.get(SEAL)).toContain(`insert into ${TABLE}`);
    expect(real.get(SEAL)).toContain(`update ${TABLE}`);
    expect(real.get(SEAL)).toContain(`delete from ${TABLE}`);
    expect(real.get(INSTALLER)).toContain(`create table if not exists ${TABLE}`);
    expect(real.get('authz/page-write/compaction.ts')).toContain('deleteSealInTransaction(');
    expect(real.get('authz/page-write/heal-image.ts')).toContain('claimSealRow(');
  });

  it('flags a second writer, a write from the installer, and a statement called from elsewhere', () => {
    const real = serverSources();
    const other = new Map(real);
    other.set('authz/page-write/other.ts', `const q = sql\`update ${TABLE} set entries = null where page_id = \${p}\`;`);
    expect(findings(other)).toEqual([{ file: 'authz/page-write/other.ts', why: `names ${TABLE} (binding-seal.ts is its only writer)` }]);
    const installer = new Map(real);
    installer.set(INSTALLER, `${real.get(INSTALLER)}\nawait sql\`delete from ${TABLE}\`.execute(trx);`);
    expect(findings(installer)).toEqual([{ file: INSTALLER, why: `names ${TABLE} outside its create table` }]);
    const caller = new Map(real);
    caller.set('collaboration/extensions/persistence.extension.ts', `${real.get('collaboration/extensions/persistence.extension.ts')}\ncommitSealRow(db, p, l, true, s);`);
    expect(findings(caller)).toEqual([{ file: 'collaboration/extensions/persistence.extension.ts', why: 'calls commitSealRow' }]);
    // a comment naming the table is not a statement
    const commented = new Map(real);
    commented.set('authz/page-write/other.ts', `// see ${TABLE}\nexport const x = 1;`);
    expect(findings(commented)).toEqual([]);
  });
});
