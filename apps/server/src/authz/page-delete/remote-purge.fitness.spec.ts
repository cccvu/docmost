import { readFileSync } from 'fs';
import { join } from 'path';
import * as ts from 'typescript';
import { literalText, ownerOf, sourceFiles } from '../route-guard/ast-sink-scan';
import { scanRoutes } from '../route-guard/static-route-scan';

// The interceptor module's graph reaches PageService, which pulls in the collab WebSocket stack (lib0 ESM). Stub it.
jest.mock('../../collaboration/collaboration.gateway', () => ({ CollaborationGateway: class {} }));

import { NATIVE_PURGE_ROUTES, NATIVE_RESTORE_ROUTES } from './remote-purge.interceptor';

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
 * Remote page-lifecycle FITNESS TEST (#636 W6, #661, #589, #670, #556) — NOT upstream Docmost code.
 *
 * In remote mode every route that removes pages must go through the remote removal routines: `RemotePurgeService`
 * (space admin on every space AND `page#edit` on every page removed, under locks, after a settle fence) and
 * `RemoteTrashService` (`page#edit` on every page trashed, under locks, trashing exactly those). Two entry points do:
 * the native `PageController.delete`, through `RemotePurgeInterceptor`, and the fork's
 * `ConditionalPageOpsController.conditionalDelete`, through its remote branch. The trash retention is
 * `RemoteTrashRetentionService` (seam #183). This pins, statically (no imports of the real controllers, no boot):
 *  - every `pages` row DELETE, per METHOD and per occurrence: `PageService.forceDelete`, the trash-retention job's
 *    `TrashCleanupService.cleanupPage` (an @Interval, no route), and the dead `PageRepo.deletePage` (no caller);
 *  - every `.forceDelete(` call: the two routes above, `RemotePurgeService.purge` and the remote retention — so the
 *    routes that reach it are exactly those two, and the interceptor's key set is exactly the upstream one;
 *  - every `.removePage(` call (the trash sink): `PageService.removePage`, the two routes and `RemoteTrashService`;
 *  - every `.restorePage(` call (the restore sink, #556): the native `PageController.restore` and `RemoteRestoreService`,
 *    so the restore routes are exactly that one, and the interceptor's restore key set is exactly the upstream one;
 *  - the routines' callers and the holders of an injected `RemotePurgeService` / `RemoteTrashService` /
 *    `RemoteRestoreService`;
 *  - that `conditionalDelete` dispatches remote mode to the routines FIRST, before its native replica;
 *  - that page.module.ts registers the trash retention through the mode-selecting provider, never the bare class;
 *  - that the acting-service header is read only by the two entry points, parsed only by `parseActingService`, used
 *    only as a `serviceSubject(…)` handed to `decideAll`, and never reaches a log or audit call;
 *  - that app.module.ts registers the interceptor once, after the per-principal rate limiter, and main.ts still applies
 *    the response envelope the interceptor reproduces.
 * A new method or route that reaches a hop fails RED, and whoever adds it decides deliberately whether it needs the
 * remote routines too. A static inventory: a sink reached through an unrecognized indirection (a method passed by
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
  | 'removePageCall'
  | 'restorePageCall'
  | 'deletePageCall'
  | 'cleanupPageCall'
  | 'retireCall'
  | 'purgeCall'
  | 'trashCall'
  | 'restoreCall'
  | 'purgeServiceInjection'
  | 'trashServiceInjection'
  | 'restoreServiceInjection';
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
export function scanPurgeSinks(
  fileName: string,
  source: string,
  purgeHolders: ReadonlySet<string>,
  trashHolders: ReadonlySet<string> = new Set(),
  restoreHolders: ReadonlySet<string> = new Set(),
): SinkSite[] {
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
      if (name === 'removePage') sites.push({ kind: 'removePageCall', owner });
      if (name === 'restorePage') sites.push({ kind: 'restorePageCall', owner });
      if (name === 'deletePage') sites.push({ kind: 'deletePageCall', owner });
      if (name === 'cleanupPage') sites.push({ kind: 'cleanupPageCall', owner });
      if (name === 'retire') sites.push({ kind: 'retireCall', owner });
      if (name === 'purge' && purgeHolders.has(receiverName(node.expression.expression) ?? '')) {
        sites.push({ kind: 'purgeCall', owner });
      }
      if (name === 'trash' && trashHolders.has(receiverName(node.expression.expression) ?? '')) {
        sites.push({ kind: 'trashCall', owner });
      }
      if (name === 'restore' && restoreHolders.has(receiverName(node.expression.expression) ?? '')) {
        sites.push({ kind: 'restoreCall', owner });
      }
    }
    if (
      ts.isParameter(node) &&
      ts.isConstructorDeclaration(node.parent) &&
      node.type &&
      ts.isTypeReferenceNode(node.type) &&
      ts.isIdentifier(node.name)
    ) {
      const type = node.type.typeName.getText(sf);
      const kind: SinkKind | undefined =
        type === 'RemotePurgeService'
          ? 'purgeServiceInjection'
          : type === 'RemoteTrashService'
            ? 'trashServiceInjection'
            : type === 'RemoteRestoreService'
              ? 'restoreServiceInjection'
              : undefined;
      if (kind) sites.push({ kind, owner: `${ownerOf(node).replace(/\.constructor$/, '')}#${node.name.text}` });
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
  // The property names the routines are injected under, so a `.purge(` / `.trash(` on any other receiver is not counted.
  const injected = (kind: SinkKind) =>
    raw.flatMap((f) =>
      scanPurgeSinks(f.file, f.src, new Set()).filter((s) => s.kind === kind).map((s) => `${f.file}:${s.owner}`),
    );
  const holders = injected('purgeServiceInjection');
  const trashHolders = injected('trashServiceInjection');
  const restoreHolders = injected('restoreServiceInjection');
  const holderNames = new Set(holders.map((h) => h.split('#')[1]));
  const trashHolderNames = new Set(trashHolders.map((h) => h.split('#')[1]));
  const restoreHolderNames = new Set(restoreHolders.map((h) => h.split('#')[1]));
  const files = raw.map((f) => ({
    ...f,
    sinks: scanPurgeSinks(f.file, f.src, holderNames, trashHolderNames, restoreHolderNames),
  }));
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

  it('`.forceDelete(` is called by exactly the two purge routes, the purge routine and the remote retention', () => {
    expect(sitesOf('forceDeleteCall')).toEqual([
      'authz/page-delete/remote-purge.service.ts:RemotePurgeService.purge',
      'authz/page-delete/remote-trash-retention.service.ts:RemoteTrashRetentionService.retire',
      'authz/page-write/conditional-page-ops.controller.ts:ConditionalPageOpsController.conditionalDelete',
      'core/page/page.controller.ts:PageController.delete',
    ]);
    const reachingRoutes = sitesOf('forceDeleteCall')
      .map((s) => s.split(':')[1])
      .filter((k) => routeByKey.has(k))
      .sort();
    expect(reachingRoutes).toEqual(['ConditionalPageOpsController.conditionalDelete', 'PageController.delete']);
  });

  it('the remote retention purges only from its interval job (no route reaches it)', () => {
    expect(sitesOf('retireCall')).toEqual([
      'authz/page-delete/remote-trash-retention.service.ts:RemoteTrashRetentionService.cleanupOldTrash',
    ]);
    expect(routes.filter((r) => r.controller === 'RemoteTrashRetentionService')).toEqual([]);
  });

  it('`.removePage(` (the trash sink) is called by PageService, the two delete routes and the remote trash routine only', () => {
    expect(sitesOf('removePageCall')).toEqual([
      'authz/page-delete/remote-trash.service.ts:RemoteTrashService.decideAndTrash',
      'authz/page-write/conditional-page-ops.controller.ts:ConditionalPageOpsController.conditionalDelete',
      'core/page/page.controller.ts:PageController.delete',
      'core/page/services/page.service.ts:PageService.removePage',
    ]);
    const reachingRoutes = sitesOf('removePageCall')
      .map((s) => s.split(':')[1])
      .filter((k) => routeByKey.has(k))
      .sort();
    expect(reachingRoutes).toEqual(['ConditionalPageOpsController.conditionalDelete', 'PageController.delete']);
  });

  it('the interceptor is keyed to exactly the UPSTREAM routes that reach forceDelete or removePage', () => {
    const upstream = [...sitesOf('forceDeleteCall'), ...sitesOf('removePageCall')]
      .filter((s) => !s.startsWith('authz/'))
      .map((s) => s.split(':')[1])
      .filter((k) => routeByKey.has(k));
    expect([...NATIVE_PURGE_ROUTES].sort()).toEqual([...new Set(upstream)].sort());
  });

  it('`.restorePage(` (the restore sink, #556) is called by the native restore route and the remote restore routine only', () => {
    expect(sitesOf('restorePageCall')).toEqual([
      'authz/page-delete/remote-restore.service.ts:RemoteRestoreService.decideAndRestore',
      'core/page/page.controller.ts:PageController.restore',
    ]);
    const reachingRoutes = sitesOf('restorePageCall')
      .map((s) => s.split(':')[1])
      .filter((k) => routeByKey.has(k))
      .sort();
    expect(reachingRoutes).toEqual(['PageController.restore']);
  });

  it('the interceptor’s restore key set is exactly the UPSTREAM routes that reach restorePage, disjoint from the delete set', () => {
    const upstream = sitesOf('restorePageCall')
      .filter((s) => !s.startsWith('authz/'))
      .map((s) => s.split(':')[1])
      .filter((k) => routeByKey.has(k));
    expect([...NATIVE_RESTORE_ROUTES].sort()).toEqual([...new Set(upstream)].sort());
    expect([...NATIVE_RESTORE_ROUTES].filter((k) => NATIVE_PURGE_ROUTES.has(k))).toEqual([]);
  });

  it('RemoteRestoreService is injected only into the interceptor, and only its intercept calls it (#556)', () => {
    expect(restoreHolders.sort()).toEqual(['authz/page-delete/remote-purge.interceptor.ts:RemotePurgeInterceptor#restore']);
    expect(sitesOf('restoreCall')).toEqual(['authz/page-delete/remote-purge.interceptor.ts:RemotePurgeInterceptor.intercept']);
  });

  it('RemotePurgeService and RemoteTrashService are injected only into their two entry points, and only they call them', () => {
    expect(holders.sort()).toEqual([
      'authz/page-delete/remote-purge.interceptor.ts:RemotePurgeInterceptor#purge',
      'authz/page-write/conditional-page-ops.controller.ts:ConditionalPageOpsController#remotePurge',
    ]);
    expect(sitesOf('purgeCall')).toEqual([
      'authz/page-delete/remote-purge.interceptor.ts:RemotePurgeInterceptor.intercept',
      'authz/page-write/conditional-page-ops.controller.ts:ConditionalPageOpsController.conditionalDelete',
    ]);
    expect(trashHolders.sort()).toEqual([
      'authz/page-delete/remote-purge.interceptor.ts:RemotePurgeInterceptor#trash',
      'authz/page-write/conditional-page-ops.controller.ts:ConditionalPageOpsController#remoteTrash',
    ]);
    expect(sitesOf('trashCall')).toEqual([
      'authz/page-delete/remote-purge.interceptor.ts:RemotePurgeInterceptor.intercept',
      'authz/page-write/conditional-page-ops.controller.ts:ConditionalPageOpsController.conditionalDelete',
    ]);
  });

  it('conditionalDelete dispatches remote mode to the routines FIRST, and returns from them', () => {
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
    expect(squash(branch.expression.getText(sf))).toBe("this.mode==='remote'");
    const then = squash(branch.thenStatement.getText(sf));
    expect(then).toContain('constactingServiceId=parseActingService(actingService);');
    expect(then).toContain('this.remotePurge.purge(user,dto.pageId,workspace.id,dto.expectedEtags,actingServiceId)');
    expect(then).toContain('this.remoteTrash.trash(user,dto.pageId,workspace.id,dto.expectedEtags,actingServiceId)');
    expect(then).not.toContain('forceDelete');
    expect(then).not.toContain('removePage');
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

  it('page.module.ts registers the trash retention through the mode-selecting provider, never the bare upstream class', () => {
    const mod = files.find((f) => f.file === 'core/page/page.module.ts')?.src ?? '';
    const providers = squash(/providers:\s*\[([^\]]*)\]/.exec(mod)?.[1] ?? '').replace(/\/\/[^,\]]*/g, '');
    expect(providers.split(',')).toContain('trashCleanupProvider');
    expect(referencesIdentifier('page.module.ts', mod, 'TrashCleanupService')).toBe(false);
    const provider = files.find((f) => f.file === 'authz/page-delete/trash-retention.provider.ts')?.src ?? '';
    expect(squash(provider)).toContain('provide:TrashCleanupService,');
    expect(squash(provider)).toContain("mode==='remote'?newRemoteTrashRetentionService(");
    // Registered nowhere else: one instance under the token, so exactly one 'trash-cleanup' interval.
    const registrations = files
      .filter((x) => x.file !== 'authz/page-delete/trash-retention.provider.ts' && x.file !== 'core/page/services/trash-cleanup.service.ts')
      .filter((x) => x.file !== 'authz/page-delete/remote-trash-retention.service.ts')
      .filter(
        (x) =>
          referencesIdentifier(x.file, x.src, 'TrashCleanupService') ||
          referencesIdentifier(x.file, x.src, 'RemoteTrashRetentionService') ||
          (x.file !== 'core/page/page.module.ts' && referencesIdentifier(x.file, x.src, 'trashCleanupProvider')),
      )
      .map((x) => x.file);
    expect(registrations).toEqual([]);
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

/** Identifiers that carry the delegated service account id (#670). */
const ACTING_TAINT = new Set(['ACTING_SERVICE_HEADER', 'actingService', 'actingServiceId', 'serviceSubjectId', 'parseActingService']);
const LOG_METHODS = new Set(['log', 'warn', 'error', 'debug', 'verbose', 'fatal']);

/**
 * The acting-service sites of one file: every use of the header constant or its literal (outside imports), every
 * `parseActingService(` / `serviceSubject(` call (with the call it is an argument of), and every log/audit call whose
 * arguments mention a tainted identifier. Pure; exported for the meta-guard.
 */
export function scanActingService(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const mentionsTaint = (n: ts.Node): boolean => {
    let hit = false;
    const visit = (m: ts.Node): void => {
      if (hit) return;
      if (ts.isIdentifier(m) && ACTING_TAINT.has(m.text)) hit = true;
      else ts.forEachChild(m, visit);
    };
    visit(n);
    return hit;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node) && node.text === 'ACTING_SERVICE_HEADER') out.push(`header@${ownerOf(node)}`);
    if (literalText(node) === 'x-ccc-acting-service') out.push(`literal@${ownerOf(node)}`);
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
      if (name === 'parseActingService') out.push(`parse@${ownerOf(node)}`);
      if (name === 'serviceSubject') {
        const parent = node.parent;
        const into =
          ts.isCallExpression(parent) && ts.isIdentifier(parent.expression)
            ? parent.expression.text
            : ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression)
              ? parent.expression.name.text
              : '<not-an-argument>';
        out.push(`serviceSubject->${into}@${ownerOf(node)}`);
      }
      const isLog = ts.isPropertyAccessExpression(callee) && LOG_METHODS.has(callee.name.text);
      if (isLog && node.arguments.some((a) => mentionsTaint(a))) out.push(`logged@${ownerOf(node)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe('the acting-service header only narrows, and never reaches a log or an audit row (#670)', () => {
  const sites = sourceFiles(SRC_ROOT)
    .map((full) => ({ file: full.slice(SRC_ROOT.length + 1).split('\\').join('/'), src: readFileSync(full, 'utf8') }))
    .filter((f) => f.file !== 'authz/page-delete/acting-service.ts')
    .flatMap((f) => scanActingService(f.file, f.src).map((s) => `${f.file}:${s}`))
    .sort();

  it('is read only by the two entry points, parsed only there, and handed only to decideAll as a service subject (#556: the restore too)', () => {
    expect(sites).toEqual([
      'authz/page-delete/remote-purge.interceptor.ts:header@RemotePurgeInterceptor.intercept',
      'authz/page-delete/remote-purge.interceptor.ts:parse@RemotePurgeInterceptor.intercept',
      'authz/page-delete/remote-purge.service.ts:serviceSubject->requirePurgeRights@RemotePurgeService.purge',
      'authz/page-delete/remote-restore.service.ts:serviceSubject->decideAll@RemoteRestoreService.decideAndRestore',
      'authz/page-delete/remote-trash.service.ts:serviceSubject->decideAll@RemoteTrashService.decideAndTrash',
      'authz/page-write/conditional-page-ops.controller.ts:header@ConditionalPageOpsController.conditionalDelete',
      'authz/page-write/conditional-page-ops.controller.ts:parse@ConditionalPageOpsController.conditionalDelete',
    ]);
  });

  it('requirePurgeRights hands its subject only to decideAll (so the purge’s service subject reaches nothing else)', () => {
    const src = readFileSync(join(SRC_ROOT, 'authz/page-delete/remote-purge.service.ts'), 'utf8');
    const sf = ts.createSourceFile('remote-purge.service.ts', src, ts.ScriptTarget.Latest, true);
    const uses: string[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isMethodDeclaration(n) && n.name.getText(sf) === 'requirePurgeRights' && n.body) {
        const walk = (m: ts.Node): void => {
          if (ts.isIdentifier(m) && m.text === 'subject' && !ts.isParameter(m.parent)) {
            const call = m.parent;
            uses.push(ts.isCallExpression(call) && ts.isIdentifier(call.expression) ? call.expression.text : '<other>');
          }
          ts.forEachChild(m, walk);
        };
        walk(n.body);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(uses).toEqual(['decideAll', 'decideAll']);
  });

  it('meta-guard: the scanner flags a log or audit call that mentions the id, and a subject that goes anywhere else', () => {
    const scan = (src: string) => scanActingService('probe.ts', src);
    expect(scan('class C { m(actingServiceId) { this.logger.warn(`x=${actingServiceId}`); } }')).toEqual(['logged@C.m']);
    expect(scan('class C { m(serviceSubjectId) { this.auditService.log({ metadata: { sa: serviceSubjectId } }); } }')).toEqual([
      'logged@C.m',
    ]);
    expect(scan('class C { m(id) { this.cache.set(serviceSubject(id)); } }')).toEqual(['serviceSubject->set@C.m']);
    expect(scan('class C { m(id) { const s = serviceSubject(id); } }')).toEqual(['serviceSubject-><not-an-argument>@C.m']);
    expect(scan("class C { m(req) { return req.headers['x-ccc-acting-service']; } }")).toEqual(['literal@C.m']);
    expect(scan('class C { m(id) { this.logger.warn(`x=${id}`); } }')).toEqual([]);
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
    expect(kinds(`class C { h() { return this.pageService.removePage(id, u, ws); } }`)).toEqual(['removePageCall@C.h']);
    expect(kinds(`class C { h() { return this.pageRepo.restorePage(id, ws, trx, { pageIds }); } }`)).toEqual([
      'restorePageCall@C.h',
    ]);
    expect(
      scanPurgeSinks('probe.ts', `class C { h() { return this.restore.restore(u, p, w); } }`, new Set(), new Set(), new Set(['restore'])).map(
        (x) => `${x.kind}@${x.owner}`,
      ),
    ).toEqual(['restoreCall@C.h']);
    expect(kinds(`class C { h() { return this.snapshots.restore(k); } }`)).toEqual([]);
    expect(kinds(`class C { constructor(private readonly restore: RemoteRestoreService) {} }`)).toEqual([
      'restoreServiceInjection@C#restore',
    ]);
    expect(kinds(`class C { h() { return this.retire(id, ws, cutoff); } }`)).toEqual(['retireCall@C.h']);
    expect(
      scanPurgeSinks('probe.ts', `class C { h() { return this.remoteTrash.trash(u, p, w); } }`, new Set(), new Set(['remoteTrash'])).map(
        (x) => `${x.kind}@${x.owner}`,
      ),
    ).toEqual(['trashCall@C.h']);
    expect(kinds(`class C { h() { return this.bin.trash(k); } }`)).toEqual([]);
    expect(kinds(`class C { constructor(private readonly remoteTrash: RemoteTrashService) {} }`)).toEqual([
      'trashServiceInjection@C#remoteTrash',
    ]);
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
