import { readFileSync } from 'fs';
import { join } from 'path';
import * as ts from 'typescript';
import { sourceFiles } from '../route-guard/ast-sink-scan';
import { handlerCalls, scanRoutes } from '../route-guard/static-route-scan';
import { appInterceptors } from '../route-guard/app-module-scan';
import { REMOTE_REFUSED_ROUTES } from '../remote-refusal/remote-refusal.table';
import { REMOTE_STEP_UP_ROUTES, StepUpKind, purgesPermanently, stepUpRoutesOf } from './remote-step-up.table';

/**
 * Remote step-up table FITNESS TEST (wiki-v2 #713) — NOT upstream Docmost code.
 *
 * `RemoteStepUpInterceptor` matches by `Controller.handler` key, so the table is only as good as those strings. This
 * pins them statically against the source (no boot):
 *  - every key names a real, authenticated `@Post` route whose scanned path equals `entry.route`;
 *  - each kind is pinned BOTH ways against the handler text that reaches its sink: the routes that reach it are
 *    EXACTLY the kind's keys plus a reasoned KEEP list. An upstream bump that renames a gated handler (its key would
 *    silently stop matching) or adds a second route reaching the sink fails RED, and whoever does it decides: gate it,
 *    or keep it with a reason. A KEEP entry must still carry the tell, so the list cannot go stale;
 *  - the purge keys carry the permanent-delete predicate and the others carry none (a trash stays ungated, and an
 *    ACL write is gated whatever its body says);
 *  - app.module.ts registers the interceptor EXACTLY once, after the refusal and the per-principal rate limiter and
 *    BEFORE `RemotePurgeInterceptor` (which never calls the handler, so a later step-up check would never run), read
 *    from the TS AST of the providers; nothing else names the class (no second registration, none in the collab app).
 * A static text heuristic: a sink reached through an unrecognized indirection is invisible to it.
 */
const SRC_ROOT = join(__dirname, '..', '..'); // .../apps/server/src
const INTERCEPTOR = 'RemoteStepUpInterceptor';

/** The handler-text tell of each kind's sink. The `(` right after the name keeps longer names out. */
export const STEP_UP_SINK_RE: Record<StepUpKind, RegExp> = {
  // The remote purge routine, and upstream's own permanent delete (the native-mode branch).
  purge: /\.(?:purge|forceDelete)\s*\(/,
  // PageRestrictionService's five writes.
  pageAcl: /\.(?:restrict|unrestrict|addPermission|removePermission|updatePermission)\s*\(/,
  // SpaceService.updateSpace — public sharing, viewer comments, name, slug.
  spaceSettings: /\.updateSpace\s*\(/,
};

/** Routes that reach a kind's sink yet are deliberately NOT gated, each with its reason. */
const KEEP: Record<StepUpKind, ReadonlyMap<string, string>> = {
  purge: new Map(),
  pageAcl: new Map(),
  spaceSettings: new Map(),
};

/**
 * Route families deliberately NOT stepped up (#713 review), each pinned both ways against its own tell like a kind:
 * the routes reaching the tell are EXACTLY the listed keys, so a new export route or share write must be classified
 * here (or gated in the table) by whoever adds it.
 */
const NOT_STEPPED_UP: ReadonlyArray<{ family: string; tell: RegExp; keys: string[]; reason: string }> = [
  {
    family: 'exports',
    tell: /\.export(?:Space|Pages|Page)\s*\(/,
    keys: ['ExportController.exportPage', 'ExportController.exportSpace'],
    reason:
      'reads: nothing is stepped up for reading, here or on the platform. The page/subtree export and /v1/pages/export ' +
      'reach the same content ungated, so gating the space export alone was cosmetic',
  },
  {
    family: 'share writes',
    tell: /\.(?:createShare|updateShare|deleteShare)\s*\(|insert into ccc_share_expiry/,
    keys: ['ShareController.create', 'ShareController.update', 'ShareController.delete', 'ShareExpiryController.set'],
    reason:
      'an editor content op decided on page#edit; a restricted page is refused, and whether a space may share at ' +
      'all is the space settings toggle, which IS stepped up (SpaceController.updateSpace)',
  },
];

const KINDS = Object.keys(STEP_UP_SINK_RE) as StepUpKind[];

/** Files (relative to SRC_ROOT) whose code — not comments or strings — names `identifier`. */
function filesReferencing(identifier: string): string[] {
  const hits: string[] = [];
  for (const full of sourceFiles(SRC_ROOT)) {
    const src = readFileSync(full, 'utf8');
    if (!src.includes(identifier)) continue;
    const sf = ts.createSourceFile(full, src, ts.ScriptTarget.Latest, true);
    let found = false;
    const visit = (n: ts.Node): void => {
      if (found) return;
      if (ts.isIdentifier(n) && n.text === identifier) found = true;
      else ts.forEachChild(n, visit);
    };
    visit(sf);
    if (found) hits.push(full.slice(SRC_ROOT.length + 1).split('\\').join('/'));
  }
  return hits.sort();
}

describe('the remote step-up table names real routes and covers every route that reaches its sinks (#713)', () => {
  const routes = scanRoutes(SRC_ROOT);
  const key = (r: { controller: string; handler: string }) => `${r.controller}.${r.handler}`;
  const byKey = new Map(routes.map((r) => [key(r), r]));

  it('scans a meaningful tree (guards against a silently-empty scan)', () => {
    expect(routes.length).toBeGreaterThanOrEqual(80);
    expect(REMOTE_STEP_UP_ROUTES.size).toBeGreaterThanOrEqual(8);
  });

  it.each([...REMOTE_STEP_UP_ROUTES].map(([k, e]) => [k, e.route]))('%s is a real @Post route at %s', (k, route) => {
    const r = byKey.get(k);
    expect(r).toBeDefined();
    expect(r!.handlerText).toMatch(/@Post\s*\(/);
    expect(`POST ${r!.httpPath}`).toBe(route);
    // The interceptor reads the session the JwtAuthGuard resolved; a @Public route has none.
    expect(r!.isPublic).toBe(false);
  });

  it.each(KINDS)('%s: the routes reaching the sink are EXACTLY the gated keys plus KEEP', (kind) => {
    const reaching = routes.filter((r) => handlerCalls(r, STEP_UP_SINK_RE[kind])).map(key).sort();
    expect(reaching).toEqual([...stepUpRoutesOf(kind), ...KEEP[kind].keys()].sort());
  });

  it.each(KINDS)('%s: KEEP is disjoint from the gated keys and every entry has a reason', (kind) => {
    const gated = stepUpRoutesOf(kind);
    expect([...KEEP[kind].keys()].filter((k) => gated.has(k))).toEqual([]);
    for (const reason of KEEP[kind].values()) expect(reason.length).toBeGreaterThan(20);
  });

  it.each(NOT_STEPPED_UP.map((f) => [f.family, f]))(
    'not stepped up — %s: real authenticated routes, EXACTLY the routes reaching the tell, none gated, with a reason',
    (_family, f) => {
      for (const k of f.keys) {
        expect([k, byKey.get(k)?.isPublic]).toEqual([k, false]);
        expect([k, REMOTE_STEP_UP_ROUTES.has(k)]).toEqual([k, false]);
      }
      const reaching = routes.filter((r) => handlerCalls(r, f.tell)).map(key).sort();
      expect(reaching).toEqual([...f.keys].sort());
      expect(f.reason.length).toBeGreaterThan(40);
    },
  );

  it('exactly the purge keys carry the permanent-delete predicate', () => {
    for (const [k, e] of REMOTE_STEP_UP_ROUTES) {
      expect([k, e.when]).toEqual([k, e.kind === 'purge' ? purgesPermanently : undefined]);
    }
  });

  it('no gated route is also refused (a refused route stays a 404, never a step-up prompt)', () => {
    expect([...REMOTE_STEP_UP_ROUTES.keys()].filter((k) => REMOTE_REFUSED_ROUTES.has(k))).toEqual([]);
  });

  it('app.module.ts registers it once, after the refusal and rate limiter, before the remote purge', () => {
    const order = appInterceptors('app.module.ts', readFileSync(join(SRC_ROOT, 'app.module.ts'), 'utf8'));
    expect(order.filter((c) => c === INTERCEPTOR)).toHaveLength(1);
    const at = order.indexOf(INTERCEPTOR);
    expect(at).toBeGreaterThan(order.indexOf('ApiAccessAuditInterceptor'));
    expect(at).toBeGreaterThan(order.indexOf('PrincipalRateLimitInterceptor'));
    expect(at).toBeGreaterThan(order.indexOf('RemoteNativeRefusalInterceptor'));
    expect(order).toContain('RemotePurgeInterceptor');
    expect(at).toBeLessThan(order.indexOf('RemotePurgeInterceptor'));
  });

  it('only app.module.ts and the interceptor’s own file name the class (no second registration elsewhere)', () => {
    expect(filesReferencing(INTERCEPTOR)).toEqual(['app.module.ts', 'authz/step-up/remote-step-up.interceptor.ts']);
  });
});

describe('the step-up sink tells (meta-guard)', () => {
  it.each<[StepUpKind, string]>([
    ['purge', 'await this.remotePurge.purge(user, dto.pageId)'],
    ['purge', 'await this.pageService.forceDelete(page.id, workspace.id)'],
    ['pageAcl', 'this.restriction.restrict(dto.pageId, user)'],
    ['pageAcl', 'this.restriction.unrestrict (dto.pageId, user)'],
    ['pageAcl', 'this.restriction.updatePermission(dto, user)'],
    ['spaceSettings', 'this.spaceService.updateSpace(dto, workspace.id)'],
  ])('%s matches %s', (kind, text) => {
    expect(STEP_UP_SINK_RE[kind].test(text)).toBe(true);
  });

  it.each<[StepUpKind, string]>([
    ['purge', 'this.remoteTrash.trash(user, pageId)'],
    ['purge', 'purgeCache()'],
    ['pageAcl', 'this.restriction.preview(dto, user)'],
    ['pageAcl', 'this.restriction.restrictionPreview(dto)'],
    ['spaceSettings', 'this.spaceService.updateSpaceMemberRole(dto)'],
  ])('%s does not match %s', (kind, text) => {
    expect(STEP_UP_SINK_RE[kind].test(text)).toBe(false);
  });
});
