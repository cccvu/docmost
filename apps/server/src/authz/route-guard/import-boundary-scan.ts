import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve, dirname, sep } from 'path';
import * as ts from 'typescript';

/**
 * CCC fork-independence import-boundary scanner — NOT upstream Docmost code (GitHub #172, epic #157, ADR 0014).
 *
 * The import-graph complement to the file-diff boundary check (`scripts/check-upstream-boundary.sh`). That
 * check answers "did an upstream file change vs the v0.95.0 base tag?"; it is structurally blind to IMPORTS
 * (it never inspects a file under an excluded prefix like `authz/`, can't see dependency direction, can't
 * catch an import into the empty `ee/` gitlink). This scanner parses every `apps/server/src/**` source with
 * the TypeScript compiler API — deliberately NOT by importing/booting anything (same rationale as
 * static-route-scan.ts: import reflection would drag the transitive service graph / DB / workspace packages
 * through jest) — and CLASSIFIES every import edge so a fitness test can assert the fork's independence
 * invariants. It is a STATIC over-report: it can only over-flag, never miss an import that is written.
 *
 * The classification is intentionally coarse and fail-closed. Four edge kinds matter to the boundary:
 *   - 'ee'     — resolves into `apps/server/src/ee/` (the empty EE gitlink; CLAUDE.md hard-rule #1). No fork
 *                code may import it — it breaks the standalone build and would pull Docmost's closed EE.
 *   - 'escape' — a RELATIVE specifier that resolves OUTSIDE the fork root (`docmost/`). This is the real
 *                "fork depends on the super repo": a `../../../../services/...` climb RESOLVES in a super
 *                checkout (where `docmost/` is a subdir) so it passes the fork's own build, yet breaks a
 *                standalone clone. The one non-vacuous, non-build-covered independence guard.
 *   - 'ccc'    — resolves into `apps/server/src/authz/` or `apps/server/src/service-bridge/` (the first-class
 *                CCC modules). An UPSTREAM-owned file importing these is wrong-direction coupling — CCC
 *                integration must enter upstream ONLY at the documented DI/composition seams. (The spec owns
 *                the upstream/CCC classification + the seam allowlist; the scanner just reports the edge.)
 *   - 'other'  — anything else (node_modules OSS deps, `@docmost/{db,transactional,base-formula}` aliases,
 *                internal upstream/CCC relative imports). Not boundary-relevant.
 *
 * Guards are matched by the raw import SPECIFIER resolved against the importing file — every import form is
 * collected (static import, `import type`, `export … from`, dynamic `import()`, `require()`,
 * `import x = require()`), mirroring how the pg-callsites scanner (#49) recognizes every construction shape.
 */

const SKIP_DIRS = new Set(['node_modules', 'dist']);

export type EdgeKind = 'ee' | 'escape' | 'ccc' | 'other';

export interface ImportEdge {
  /** importing file, relative to srcRoot (POSIX-ish, OS sep). */
  file: string;
  /** the raw module specifier as written. */
  specifier: string;
  kind: EdgeKind;
}

function walkTsFiles(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walkTsFiles(full, out);
    } else if (
      name.endsWith('.ts') &&
      !name.endsWith('.d.ts') &&
      !name.endsWith('.spec.ts')
    ) {
      out.push(full);
    }
  }
}

/** Every module specifier a source file references — import / export-from / dynamic import() / require(). */
export function collectSpecifiers(sf: ts.SourceFile): string[] {
  const specs: string[] = [];
  const visit = (node: ts.Node): void => {
    // import … from 'x'  /  import type … from 'x'  /  export … from 'x'
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specs.push(node.moduleSpecifier.text);
    }
    // import x = require('x')
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      specs.push(node.moduleReference.expression.text);
    }
    // dynamic import('x')  and  require('x')
    if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) specs.push(node.arguments[0].text);
      else if (ts.isIdentifier(callee) && callee.text === 'require') specs.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specs;
}

/** True when `abs` is `base` itself or a path inside it. */
function isUnder(abs: string, base: string): boolean {
  return abs === base || abs.startsWith(base + sep);
}

/**
 * Classify one import specifier from a file at `fileAbs`. `srcRoot` is `apps/server/src`; the fork root is
 * two levels up (`docmost/`). Pure + shared by the real-tree walk AND the meta-guard fixtures, so the
 * fixtures exercise the exact classification that gates the tree.
 */
export function classifySpecifier(fileAbs: string, specifier: string, srcRoot: string): EdgeKind {
  const forkRoot = resolve(srcRoot, '..', '..', '..'); // apps/server/src -> server -> apps -> docmost
  const eeDir = join(srcRoot, 'ee');
  const authzDir = join(srcRoot, 'authz');
  const bridgeDir = join(srcRoot, 'service-bridge');

  // The `@docmost/ee/*` alias points straight at the empty EE gitlink.
  if (specifier === '@docmost/ee' || specifier.startsWith('@docmost/ee/')) return 'ee';
  // Other `@docmost/*` aliases (db, transactional, base-formula) resolve inside the fork — never boundary-relevant.
  if (specifier.startsWith('@docmost/')) return 'other';

  // Resolve the two specifier shapes that name a fork path: `.`-relative and the `src/…` jest/root alias.
  let abs: string | null = null;
  if (specifier.startsWith('.')) abs = resolve(dirname(fileAbs), specifier);
  else if (specifier === 'src' || specifier.startsWith('src/')) abs = join(srcRoot, specifier.slice(3).replace(/^\//, ''));
  else return 'other'; // bare node_modules specifier

  if (isUnder(abs, eeDir)) return 'ee';
  if (!isUnder(abs, forkRoot)) return 'escape'; // a relative climb out of docmost/
  if (isUnder(abs, authzDir) || isUnder(abs, bridgeDir)) return 'ccc';
  return 'other';
}

/** Classify every import edge in one source string (shared by the tree walk and the meta-guard fixtures). */
export function scanSource(fileAbs: string, src: string, srcRoot: string): ImportEdge[] {
  const sf = ts.createSourceFile(fileAbs, src, ts.ScriptTarget.Latest, /*setParentNodes*/ true, ts.ScriptKind.TS);
  const rel = fileAbs.startsWith(srcRoot + sep) ? fileAbs.slice(srcRoot.length + 1) : fileAbs;
  return collectSpecifiers(sf).map((specifier) => ({
    file: rel,
    specifier,
    kind: classifySpecifier(fileAbs, specifier, srcRoot),
  }));
}

/** Walk `apps/server/src` and classify every import edge. */
export function scanImportEdges(srcRoot: string): ImportEdge[] {
  const files: string[] = [];
  walkTsFiles(srcRoot, files);
  files.sort();
  return files.flatMap((full) => scanSource(full, readFileSync(full, 'utf8'), srcRoot));
}
