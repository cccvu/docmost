import { readFileSync } from 'fs';
import { join } from 'path';
import * as ts from 'typescript';
import { literalText, ownerOf, sourceFiles } from '../route-guard/ast-sink-scan';
import { scanRoutes } from '../route-guard/static-route-scan';

// The interceptor module's graph reaches PageService, which pulls in the collab WebSocket stack (lib0 ESM). Stub it.
jest.mock('../../collaboration/collaboration.gateway', () => ({ CollaborationGateway: class {} }));

import { NATIVE_PURGE_ROUTES } from './remote-purge.interceptor';

/** True when `name` appears as an identifier in code (comments and strings are ignored, so a doc mention is not a registration). */
function referencesIdentifier(file: string, src: string, name: string): boolean {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(n) && n.text === name) found = true;
    else ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}


/**
 * Remote purge FITNESS TEST (#636 W6) — NOT upstream Docmost code.
 *
 * In remote mode every route that permanently deletes pages must go through `RemotePurgeService` (space admin AND
 * `page#edit` on every page removed, under locks, after a settle fence). Two entry points do: the native
 * `PageController.delete`, through `RemotePurgeInterceptor`, and the fork's `ConditionalPageOpsController.conditionalDelete`,
 * through its remote branch. This pins, statically (no imports of the real controllers, no boot):
 *  - every `pages` row DELETE, per METHOD and per occurrence: `PageService.forceDelete`, the trash-retention job's
 *    `TrashCleanupService.cleanupPage` (an @Interval, no route), and the dead `PageRepo.deletePage` (no caller);
 *  - every `.forceDelete(` call: the two routes above and `RemotePurgeService.purge` — so the routes that reach it are
 *    exactly those two, and the interceptor's key set is exactly the upstream one;
 *  - the purge's callers and the holders of an injected `RemotePurgeService`;
 *  - that `conditionalDelete` dispatches a remote permanent delete to the purge FIRST, before its native replica;
 *  - that app.module.ts registers the interceptor once, after the per-principal rate limiter, and main.ts still applies
 *    the response envelope the interceptor reproduces.
 * A new method or route that reaches a hop fails RED, and whoever adds it decides deliberately whether it needs the
 * purge routine too. A static inventory: a sink reached through an unrecognized indirection (a method passed by
 * reference, a dynamic property name) is invisible to it; the meta-guard at the bottom pins the shapes it recognizes.
 */
const SRC_ROOT = join(__dirname, '..', '..'); // .../apps/server/src

// Raw SQL `DELETE FROM pages` inside a string or template literal (not `page_access`, not `pages_history`).
export const RAW_PAGES_DELETE_RE = /\bdelete\s+from\s+(?:"?public"?\.)?"?pages"?(?![\w"])/i;
// Kysely `deleteFrom('pages')` / `deleteFrom('pages as p')`.
const PAGES_TABLE_RE = /^pages(?:\s+as\s+\w+)?$/;

type SinkKind =
  | 'pagesRowDelete'
  | 'forceDeleteCall'
  | 'deletePageCall'
  | 'cleanupPageCall'
  | 'purgeCall'
  | 'purgeServiceInjection';
export interface SinkSite {
  kind: SinkKind;
  owner: string;
}

/** The receiver's LAST identifier: `this.remotePurge.purge` → `remotePurge`; `this.purge` → `this`. */
function receiverName(expr: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (ts.isIdentifier(expr)) return expr.text;
  if (expr.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  return undefined;
}

/** Every page-purge sink in one source file, attributed to its enclosing method. Pure; exported for the meta-guard. */
export function scanPurgeSinks(fileName: string, source: string, purgeHolders: ReadonlySet<string>): SinkSite[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const sites: SinkSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text;
      const first = node.arguments[0];
      const owner = ownerOf(node);
      if (name === 'deleteFrom' && first && PAGES_TABLE_RE.test(literalText(first) ?? '')) {
        sites.push({ kind: 'pagesRowDelete', owner });
      }
      if (name === 'forceDelete') sites.push({ kind: 'forceDeleteCall', owner });
      if (name === 'deletePage') sites.push({ kind: 'deletePageCall', owner });
      if (name === 'cleanupPage') sites.push({ kind: 'cleanupPageCall', owner });
      if (name === 'purge' && purgeHolders.has(receiverName(node.expression.expression) ?? '')) {
        sites.push({ kind: 'purgeCall', owner });
      }
    }
    if (
      ts.isParameter(node) &&
      ts.isConstructorDeclaration(node.parent) &&
      node.type &&
      ts.isTypeReferenceNode(node.type) &&
      node.type.typeName.getText(sf) === 'RemotePurgeService' &&
      ts.isIdentifier(node.name)
    ) {
      sites.push({ kind: 'purgeServiceInjection', owner: `${ownerOf(node).replace(/\.constructor$/, '')}#${node.name.text}` });
    }
    const text = literalText(node);
    if (text !== undefined && RAW_PAGES_DELETE_RE.test(text)) sites.push({ kind: 'pagesRowDelete', owner: ownerOf(node) });
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

const squash = (s: string) => s.replace(/\s+/g, '');

describe('every route that permanently deletes pages goes through the remote purge routine (#636 W6)', () => {
  const routes = scanRoutes(SRC_ROOT);
  const key = (r: { controller: string; handler: string }) => `${r.controller}.${r.handler}`;
  const routeByKey = new Map(routes.map((r) => [key(r), r]));
  const read = (full: string) => ({ file: full.slice(SRC_ROOT.length + 1).split('\\').join('/'), src: readFileSync(full, 'utf8') });
  const raw = sourceFiles(SRC_ROOT).map(read);
  // The property names RemotePurgeService is injected under, so a `.purge(` on any other receiver is not counted.
  const holders = raw.flatMap((f) =>
    scanPurgeSinks(f.file, f.src, new Set()).filter((s) => s.kind === 'purgeServiceInjection').map((s) => `${f.file}:${s.owner}`),
  );
  const holderNames = new Set(holders.map((h) => h.split('#')[1]));
  const files = raw.map((f) => ({ ...f, sinks: scanPurgeSinks(f.file, f.src, holderNames) }));
  const sitesOf = (kind: SinkKind) =>
    files.flatMap((f) => f.sinks.filter((s) => s.kind === kind).map((s) => `${f.file}:${s.owner}`)).sort();

  it('scans a meaningful tree (guards against a silently-empty scan)', () => {
    expect(routes.length).toBeGreaterThanOrEqual(80);
    expect(files.length).toBeGreaterThanOrEqual(300);
  });

  it('every `pages` row delete is forceDelete, the trash-retention job, or the dead repo method', () => {
    expect(sitesOf('pagesRowDelete')).toEqual([
      'core/page/services/page.service.ts:PageService.forceDelete',
      'core/page/services/trash-cleanup.service.ts:TrashCleanupService.cleanupPage',
      'database/repos/page/page.repo.ts:PageRepo.deletePage',
    ]);
  });

  it('nothing calls PageRepo.deletePage, and the trash-retention purge is reached only by its interval job (no route)', () => {
    expect(sitesOf('deletePageCall')).toEqual([]);
    expect(sitesOf('cleanupPageCall')).toEqual(['core/page/services/trash-cleanup.service.ts:TrashCleanupService.cleanupOldTrash']);
    expect(routes.filter((r) => r.controller === 'TrashCleanupService')).toEqual([]);
  });

  it('`.forceDelete(` is called by exactly the two purge routes and the purge routine', () => {
    expect(sitesOf('forceDeleteCall')).toEqual([
      'authz/page-delete/remote-purge.service.ts:RemotePurgeService.purge',
      'authz/page-write/conditional-page-ops.controller.ts:ConditionalPageOpsController.conditionalDelete',
      'core/page/page.controller.ts:PageController.delete',
    ]);
    const reachingRoutes = sitesOf('forceDeleteCall')
      .map((s) => s.split(':')[1])
      .filter((k) => routeByKey.has(k))
      .sort();
    expect(reachingRoutes).toEqual(['ConditionalPageOpsController.conditionalDelete', 'PageController.delete']);
  });

  it('the interceptor is keyed to exactly the UPSTREAM route that reaches forceDelete', () => {
    const upstream = sitesOf('forceDeleteCall')
      .filter((s) => !s.startsWith('authz/'))
      .map((s) => s.split(':')[1])
      .filter((k) => routeByKey.has(k));
    expect([...NATIVE_PURGE_ROUTES].sort()).toEqual(upstream.sort());
  });

  it('RemotePurgeService is injected only into its two entry points, and only they call it', () => {
    expect(holders.sort()).toEqual([
      'authz/page-delete/remote-purge.interceptor.ts:RemotePurgeInterceptor#purge',
      'authz/page-write/conditional-page-ops.controller.ts:ConditionalPageOpsController#remotePurge',
    ]);
    expect(sitesOf('purgeCall')).toEqual([
      'authz/page-delete/remote-purge.interceptor.ts:RemotePurgeInterceptor.intercept',
      'authz/page-write/conditional-page-ops.controller.ts:ConditionalPageOpsController.conditionalDelete',
    ]);
  });

  it('conditionalDelete dispatches a remote permanent delete to the purge FIRST, and returns from it', () => {
    const f = files.find((x) => x.file === 'authz/page-write/conditional-page-ops.controller.ts')!;
    const sf = ts.createSourceFile(f.file, f.src, ts.ScriptTarget.Latest, true);
    let body: ts.Block | undefined;
    const find = (n: ts.Node) => {
      if (ts.isMethodDeclaration(n) && n.name.getText(sf) === 'conditionalDelete') body = n.body;
      ts.forEachChild(n, find);
    };
    find(sf);
    const first = body?.statements[0];
    expect(first && ts.isIfStatement(first)).toBe(true);
    const branch = first as ts.IfStatement;
    expect(squash(branch.expression.getText(sf))).toBe("dto.permanentlyDelete&&this.mode==='remote'");
    const then = squash(branch.thenStatement.getText(sf));
    expect(then).toContain('this.remotePurge.purge(user,dto.pageId,workspace.id,dto.expectedEtags)');
    expect(then).not.toContain('forceDelete');
    const stmts = ts.isBlock(branch.thenStatement) ? branch.thenStatement.statements : [];
    expect(stmts.length > 0 && ts.isReturnStatement(stmts[stmts.length - 1])).toBe(true);
  });

  it('app.module.ts registers the interceptor exactly once, after the per-principal rate limiter, and imports its module', () => {
    const app = files.find((f) => f.file === 'app.module.ts')?.src ?? '';
    const limiter = app.indexOf('useClass: PrincipalRateLimitInterceptor');
    const purge = app.indexOf('useClass: RemotePurgeInterceptor');
    expect(limiter).toBeGreaterThan(-1);
    expect(purge).toBeGreaterThan(limiter);
    expect(app.split('useClass: RemotePurgeInterceptor').length - 1).toBe(1);
    expect(app).toMatch(/imports:\s*\[[\s\S]*\bPageDeleteModule\b[\s\S]*\]/);
    // Registered nowhere else (the collab app has no audit module, so AuthzModule / AuthzModeModule must not carry it).
    const elsewhere = files
      .filter((x) => x.file !== 'app.module.ts' && x.file !== 'authz/page-delete/remote-purge.interceptor.ts')
      .filter((x) => referencesIdentifier(x.file, x.src, 'RemotePurgeInterceptor'))
      .map((x) => x.file);
    expect(elsewhere).toEqual([]);
  });

  it('ConditionalPageModule imports the module that provides the purge to its controller', () => {
    const mod = files.find((f) => f.file === 'authz/page-write/conditional-page.module.ts')?.src ?? '';
    expect(mod).toMatch(/imports:\s*\[[^\]]*\bPageDeleteModule\b[^\]]*\]/);
  });

  it('main.ts still applies the response envelope the interceptor reproduces for the handler it skips', () => {
    const main = files.find((f) => f.file === 'main.ts')?.src ?? '';
    expect(squash(main)).toContain('app.useGlobalInterceptors(newTransformHttpResponseInterceptor(reflector));');
  });
});

describe('the page-purge sink scanner recognizes every sink shape (meta-guard)', () => {
  const kinds = (src: string, holders: string[] = ['remotePurge', 'purge']) =>
    scanPurgeSinks('probe.ts', src, new Set(holders)).map((s) => `${s.kind}@${s.owner}`);

  it.each([
    [`class R { d(ids) { return this.db.deleteFrom('pages').where('id', 'in', ids).execute(); } }`],
    [`class R { d(ids) { return dbOrTx(this.db, trx).deleteFrom("pages").where('id', 'in', ids).execute(); } }`],
    [`class R { d(ids) { return this.db.deleteFrom('pages as p').execute(); } }`],
    ['class R { d(id) { return sql`DELETE FROM pages WHERE id = ${id}`.execute(this.db); } }'],
    [`class R { d() { return this.pg.query('delete from "pages" where id = $1'); } }`],
    ['class R { d(id) { const s = sql`delete from public.pages where id = ${id}`; return s; } }'],
  ])('flags a pages-row delete: %s', (src) => {
    expect(kinds(src)).toEqual(['pagesRowDelete@R.d']);
  });

  it.each([
    [`class R { d() { return this.db.deleteFrom('page_access').execute(); } }`],
    [`class R { d() { return this.db.deleteFrom('pageHistory').execute(); } }`],
    [`const q = 'delete from pages_archive where id = $1';`],
    [`const t = 'after insert or delete or update of space_id on pages';`],
    [`// this.db.deleteFrom('pages')\n/* sql\`delete from pages\` */ const x = 1;`],
  ])('does not flag %s', (src) => {
    expect(kinds(src)).toEqual([]);
  });

  it('sees every hop, and the purge only on an injected holder', () => {
    expect(kinds(`class C { h() { return this.pageService.forceDelete(id, ws); } }`)).toEqual(['forceDeleteCall@C.h']);
    expect(kinds(`class C { h() { return this.pageRepo.deletePage(id); } }`)).toEqual(['deletePageCall@C.h']);
    expect(kinds(`class C { h() { return this.cleanupPage(id); } }`)).toEqual(['cleanupPageCall@C.h']);
    expect(kinds(`class C { h() { return this.remotePurge.purge(u, p, w); } }`)).toEqual(['purgeCall@C.h']);
    expect(kinds(`class C { h() { return this.cache.purge(k); } }`)).toEqual([]);
    expect(kinds(`class C { constructor(private readonly remotePurge: RemotePurgeService) {} }`)).toEqual([
      'purgeServiceInjection@C#remotePurge',
    ]);
  });

  it('attributes each occurrence to its enclosing method, so a NEW method in a listed file is caught', () => {
    const src = `class PageService {
      forceDelete(ids) { return this.db.deleteFrom('pages').where('id', 'in', ids).execute(); }
      bulkPurge(ids) { return this.db.deleteFrom('pages').where('id', 'in', ids).execute(); }
    }`;
    expect(kinds(src)).toEqual(['pagesRowDelete@PageService.forceDelete', 'pagesRowDelete@PageService.bulkPurge']);
  });
});
