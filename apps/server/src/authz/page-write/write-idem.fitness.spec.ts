/**
 * #781 lineage (ledger-userid-exposure) fitness function: only write-idem.ts touches the `/v1` idempotency ledger.
 *
 * The ledger root syncs to every viewer and their IndexedDB, and a Y.Map delete keeps its key in the tombstone, so an
 * entry must be the `h1:` digest of (acting user, caller key), never the user id or the key. write-idem.ts enforces
 * that by type: `recordWriteKey`/`isDuplicateWriteKey` take a `ScopedWriteKey` only (pinned in write-idem.spec.ts).
 * The one way around it is to open the root directly (`doc.getMap(WRITE_IDEM_MAP).set(rawKey, …)`), which would bring
 * back the exposure and the cross-user S1 hole. This scans every non-spec server source with the TypeScript AST
 * (comments do not count) and fails on any reference to `WRITE_IDEM_MAP` or the root's name outside the module.
 *
 * Run in CI via the `docmost-authz` job's jest glob (`… src/authz …`).
 */
import { readdirSync, readFileSync } from 'fs';
import { join, relative, resolve, sep } from 'path';
import * as ts from 'typescript';
import { WRITE_IDEM_MAP } from './write-idem';

const SRC_ROOT = resolve(__dirname, '..', '..');

/** The only non-spec file that may reference the ledger root, and how often (paths relative to apps/server/src). */
const ALLOWED: Record<string, number> = {
  // The declaration, its one string literal, and the two `getMap` calls (check, record).
  'authz/page-write/write-idem.ts': 4,
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

type Use = { file: string; line: number };

/** Every `WRITE_IDEM_MAP` identifier (an import, an alias, a use) and every string or template literal naming the
 *  root in `text`. */
const usesIn = (file: string, text: string): Use[] => {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: Use[] = [];
  const visit = (node: ts.Node): void => {
    const hit =
      (ts.isIdentifier(node) && node.text === 'WRITE_IDEM_MAP') ||
      ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text.includes(WRITE_IDEM_MAP));
    if (hit) {
      found.push({
        file: relative(SRC_ROOT, file).split(sep).join('/'),
        line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
};

describe('only write-idem.ts touches the idempotency ledger root (#781 lineage)', () => {
  const uses = walk(SRC_ROOT, []).flatMap((f) => usesIn(f, readFileSync(f, 'utf8')));

  it('no other non-spec file references WRITE_IDEM_MAP or the root name', () => {
    expect(uses.filter((u) => !(u.file in ALLOWED))).toEqual([]);
  });

  it('write-idem.ts references it exactly as often as recorded (the allowlist is not stale)', () => {
    const counts: Record<string, number> = {};
    for (const u of uses) counts[u.file] = (counts[u.file] ?? 0) + 1;
    expect(counts).toEqual(ALLOWED);
  });

  it('is not vacuous: it flags an import, a direct getMap, a renamed import and a spelled-out root, never a comment', () => {
    const count = (src: string) => usesIn(join(SRC_ROOT, 'x.ts'), src).length;
    expect(count(`import { WRITE_IDEM_MAP } from './write-idem'; doc.getMap(WRITE_IDEM_MAP).set(raw, 1);`)).toBe(2);
    expect(count(`import { WRITE_IDEM_MAP as L } from './write-idem';`)).toBe(1);
    expect(count(`doc.getMap('__ccc_write_idem').set(raw, 1);`)).toBe(1);
    expect(count('doc.getMap(`__ccc_write_idem`);')).toBe(1);
    expect(count(`// the ledger, \`__ccc_write_idem\`, is server-only\nconst x = 1;`)).toBe(0);
  });
});
