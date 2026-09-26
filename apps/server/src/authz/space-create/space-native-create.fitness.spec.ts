import { readFileSync } from 'fs';
import { join } from 'path';
import * as ts from 'typescript';
import { literalText, ownerOf, sourceFiles } from '../route-guard/ast-sink-scan';
import { NATIVE_SPACE_CREATE_CALL_RE, scanRoutes } from '../route-guard/static-route-scan';
import { NATIVE_SPACE_CREATE_ROUTES } from './space-native-create.interceptor';

/**
 * Native space create FITNESS TEST (#598) — NOT upstream Docmost code.
 *
 * Invariant I27: in remote mode the only route that creates a `spaces` row is the platform's service-bridge create
 * (`POST /api/service/spaces`). `SpaceNativeCreateInterceptor` refuses the engine's native create by
 * `Controller.handler` key, so it is only as good as that key set and the call graph behind it. This pins both
 * statically (no imports of the real controllers, no boot):
 *  - the refused set is EXACTLY the set of routes whose handler reaches `.createSpace(` — both directions;
 *  - every `spaces` ROW INSERT, per METHOD and per occurrence (TS AST, so comments never count): the upstream
 *    `SpaceRepo.insertSpace` and the service bridge's two inserts;
 *  - every hop from the upstream insert up to a route, and what closes each route in remote mode:
 *      SpaceRepo.insertSpace ← SpaceService.create ← SpaceService.createSpace ← SpaceController.createSpace
 *                                                   (refused by the interceptor)
 *                                                ← WorkspaceService.create ← SignupService.initialSetup
 *                                                   ← AuthService.setup ← AuthController.setupWorkspace
 *                                                   (first-run only; NativeAuthModeGuard 404s it in remote)
 *      ServiceSpaceService.create/createKeyed ← ServiceSpaceController.create (RemoteOnlyGuard + ServiceAuthGuard:
 *                                                   the governed path)
 *    A new method or route that reaches any hop fails RED, and whoever adds it decides deliberately whether remote
 *    mode must refuse it too;
 *  - the holders of an injected `SpaceService` (class + property name), so the receiver-name match above is sound;
 *  - app.module.ts registers the interceptor after the per-principal rate limiter (and the #502 refusal).
 * A static inventory: a sink reached through an unrecognized indirection (a method passed by reference, a dynamic
 * property name) is invisible to it. The meta-guard at the bottom pins the shapes it does recognize. The `ee`
 * directory (the personal-space route) is not scanned: it is never initialized in this repo (AGENTS.md).
 */
const SRC_ROOT = join(__dirname, '..', '..'); // .../apps/server/src

// Raw SQL `INSERT INTO spaces` inside a string or template literal (not `space_members`, not trigger DDL).
export const RAW_SPACES_ROW_INSERT_RE = /\binsert\s+into\s+(?:"?public"?\.)?"?spaces"?(?![\w"])/i;
// Kysely `insertInto('spaces')` / `insertInto('spaces as s')`: the table argument.
const SPACES_TABLE_RE = /^spaces(?:\s+as\s+\w+)?$/;

type SinkKind =
  | 'spacesRowInsert'
  | 'insertSpaceCall'
  | 'spaceServiceCreateCall'
  | 'createSpaceCall'
  | 'workspaceServiceCreateCall'
  | 'initialSetupCall'
  | 'authServiceSetupCall'
  | 'spaceServiceInjection';
export interface SinkSite {
  kind: SinkKind;
  /** `Class.method` (or the function name) that encloses the occurrence; `<module>` at top level (see `ownerOf`). */
  owner: string;
}

/** The receiver's LAST identifier: `this.spaceService.create` → `spaceService`; `this.create` → `this`. */
function receiverName(expr: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (ts.isIdentifier(expr)) return expr.text;
  if (expr.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  return undefined;
}

/** Every native space-create sink in one source file, attributed to its enclosing method. Pure; exported for the meta-guard. */
export function scanSpaceCreateSinks(fileName: string, source: string): SinkSite[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const sites: SinkSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text;
      // Exact receiver identifier, never a suffix: `workspaceService` ends in `spaceService`.
      const receiver = receiverName(node.expression.expression);
      const first = node.arguments[0];
      const owner = ownerOf(node);
      if (name === 'insertInto' && first && SPACES_TABLE_RE.test(literalText(first) ?? '')) {
        sites.push({ kind: 'spacesRowInsert', owner });
      }
      if (name === 'insertSpace') sites.push({ kind: 'insertSpaceCall', owner });
      if (
        name === 'create' &&
        (receiver === 'spaceService' || (receiver === 'this' && owner.startsWith('SpaceService.')))
      ) {
        sites.push({ kind: 'spaceServiceCreateCall', owner });
      }
      if (name === 'createSpace') sites.push({ kind: 'createSpaceCall', owner });
      if (name === 'create' && receiver === 'workspaceService') sites.push({ kind: 'workspaceServiceCreateCall', owner });
      if (name === 'initialSetup') sites.push({ kind: 'initialSetupCall', owner });
      if (name === 'setup' && receiver === 'authService') sites.push({ kind: 'authServiceSetupCall', owner });
    }
    if (
      ts.isParameter(node) &&
      ts.isConstructorDeclaration(node.parent) &&
      node.type &&
      ts.isTypeReferenceNode(node.type) &&
      node.type.typeName.getText(sf) === 'SpaceService' &&
      ts.isIdentifier(node.name)
    ) {
      sites.push({ kind: 'spaceServiceInjection', owner: `${ownerOf(node).replace(/\.constructor$/, '')}#${node.name.text}` });
    }
    const text = literalText(node);
    if (text !== undefined && RAW_SPACES_ROW_INSERT_RE.test(text)) {
      sites.push({ kind: 'spacesRowInsert', owner: ownerOf(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

describe('native space create is refused on every route that reaches it (#598, I27)', () => {
  const routes = scanRoutes(SRC_ROOT);
  const key = (r: { controller: string; handler: string }) => `${r.controller}.${r.handler}`;
  const routeByKey = new Map(routes.map((r) => [key(r), r]));
  const files = sourceFiles(SRC_ROOT).map((full) => {
    const file = full.slice(SRC_ROOT.length + 1).split('\\').join('/');
    const src = readFileSync(full, 'utf8');
    return { file, src, sinks: scanSpaceCreateSinks(file, src) };
  });
  // Every occurrence of a sink kind as `file:Owner.method`, one entry per occurrence (so a second call counts).
  const sitesOf = (kind: SinkKind) =>
    files
      .flatMap((f) => f.sinks.filter((s) => s.kind === kind).map((s) => `${f.file}:${s.owner}`))
      .sort();

  it('scans a meaningful tree (guards against a silently-empty scan)', () => {
    expect(routes.length).toBeGreaterThanOrEqual(80);
    expect(files.length).toBeGreaterThanOrEqual(300);
    expect(files.some((f) => f.sinks.length > 0)).toBe(true);
  });

  it('every refused key names a real route', () => {
    expect([...NATIVE_SPACE_CREATE_ROUTES].filter((k) => !routeByKey.has(k))).toEqual([]);
  });

  it('the refused set is EXACTLY the routes whose handler reaches the native space create', () => {
    const reaching = routes.filter((r) => r.callsNativeSpaceCreate).map(key).sort();
    expect(reaching).toEqual([...NATIVE_SPACE_CREATE_ROUTES].sort());
  });

  it('every `spaces` row insert is the upstream repo insert or one of the service bridge’s two', () => {
    expect(sitesOf('spacesRowInsert')).toEqual([
      'database/repos/space/space.repo.ts:SpaceRepo.insertSpace',
      'service-bridge/service-space.service.ts:ServiceSpaceService.create',
      'service-bridge/service-space.service.ts:ServiceSpaceService.createKeyed',
    ]);
  });

  it('`.insertSpace(` is called only by SpaceService.create', () => {
    expect(sitesOf('insertSpaceCall')).toEqual(['core/space/services/space.service.ts:SpaceService.create']);
  });

  it('SpaceService.create is reached only by SpaceService.createSpace and the first-run WorkspaceService.create', () => {
    expect(sitesOf('spaceServiceCreateCall')).toEqual([
      'core/space/services/space.service.ts:SpaceService.createSpace',
      'core/workspace/services/workspace.service.ts:WorkspaceService.create',
    ]);
  });

  it('`.createSpace(` is called only by the refused route', () => {
    expect(sitesOf('createSpaceCall')).toEqual(['core/space/space.controller.ts:SpaceController.createSpace']);
  });

  it('the first-run chain ends at AuthController.setupWorkspace, which remote mode 404s (NativeAuthModeGuard)', () => {
    expect(sitesOf('workspaceServiceCreateCall')).toEqual([
      'core/auth/services/signup.service.ts:SignupService.initialSetup',
    ]);
    expect(sitesOf('initialSetupCall')).toEqual(['core/auth/services/auth.service.ts:AuthService.setup']);
    expect(sitesOf('authServiceSetupCall')).toEqual(['core/auth/auth.controller.ts:AuthController.setupWorkspace']);
    const setup = routeByKey.get('AuthController.setupWorkspace');
    expect(setup?.guardNames).toContain('NativeAuthModeGuard');
    expect(setup?.isSessionScopedRoute).toBe(false);
  });

  it('the service bridge create — the governed path — stays remote-only and service-authenticated', () => {
    const create = routeByKey.get('ServiceSpaceController.create');
    expect(create?.guardNames).toEqual(expect.arrayContaining(['RemoteOnlyGuard', 'ServiceAuthGuard']));
  });

  it('SpaceService is injected only where the receiver-name match expects it', () => {
    expect(sitesOf('spaceServiceInjection')).toEqual([
      'core/space/space.controller.ts:SpaceController#spaceService',
      'core/workspace/services/workspace.service.ts:WorkspaceService#spaceService',
    ]);
  });

  it('app.module.ts registers the interceptor after the per-principal rate limiter and the #502 refusal', () => {
    const app = files.find((f) => f.file === 'app.module.ts')?.src ?? '';
    const limiter = app.indexOf('useClass: PrincipalRateLimitInterceptor');
    const hardDelete = app.indexOf('useClass: SpaceHardDeleteInterceptor');
    const refusal = app.indexOf('useClass: SpaceNativeCreateInterceptor');
    expect(limiter).toBeGreaterThan(-1);
    expect(hardDelete).toBeGreaterThan(limiter);
    expect(refusal).toBeGreaterThan(hardDelete);
  });
});

// The inventory is only as strong as the shapes the scanner recognizes. Pin them so a later edit cannot quietly
// narrow detection.
describe('the native space-create sink scanner recognizes every sink shape (meta-guard)', () => {
  const kinds = (src: string) => scanSpaceCreateSinks('probe.ts', src).map((s) => `${s.kind}@${s.owner}`);

  it.each([
    [`class R { i(v) { return this.db.insertInto('spaces').values(v).execute(); } }`],
    [`class R { i(v) { return this.db.insertInto("spaces").values(v).execute(); } }`],
    ['class R { i(v) { return this.db.insertInto(`spaces`).values(v).execute(); } }'],
    [`class R { i(v) { return this.db.insertInto('spaces as s').values(v).execute(); } }`],
    ['class R { i(n) { return sql`INSERT INTO spaces (name) VALUES (${n})`.execute(this.db); } }'],
    [`class R { i() { return this.pg.query('insert into "spaces" (name) values ($1)'); } }`],
    [`class R { i() { return this.pg.query('insert into public.spaces (name) values ($1)'); } }`],
    // A sink bound to a local is the METHOD's (a moved sink must change the inventory).
    ['class R { i(n) { const s = sql`insert into spaces (name) values (${n})`; return s; } }'],
  ])('flags a spaces-row insert: %s', (src) => {
    expect(kinds(src)).toEqual(['spacesRowInsert@R.i']);
  });

  it.each([
    [`class R { i(v) { return this.db.insertInto('spaceMembers').values(v).execute(); } }`],
    [`class R { i(v) { return this.db.insertInto('space_members').values(v).execute(); } }`],
    [`const t = 'after insert or delete or update of workspace_id, deleted_at on spaces';`],
    [`const q = 'insert into space_members (space_id) values ($1)';`],
    [`const q = 'insert into spaces_archive (id) values ($1)';`],
    [`// this.db.insertInto('spaces')\n/* sql\`insert into spaces\` */ const x = 1;`],
    [`class W { c() { return this.workspaceService.createWorkspace(); } }`],
  ])('does not flag %s', (src) => {
    expect(kinds(src)).toEqual([]);
  });

  it('matches the SpaceService receiver exactly — `workspaceService.create(` is a different hop', () => {
    expect(kinds(`class S { a() { this.workspaceService.create(u, d); } }`)).toEqual(['workspaceServiceCreateCall@S.a']);
    expect(kinds(`class S { a() { this.spaceService.create(u, w, d); } }`)).toEqual(['spaceServiceCreateCall@S.a']);
    expect(kinds(`class Other { a() { this.create(1); } }`)).toEqual([]);
    expect(kinds(`class SpaceService { createSpace() { return this.create(1); } }`)).toEqual([
      'spaceServiceCreateCall@SpaceService.createSpace',
    ]);
  });

  it('sees every chain hop and the SpaceService injection', () => {
    expect(kinds(`class S { c() { this.spaceRepo.insertSpace(v); } }`)).toEqual(['insertSpaceCall@S.c']);
    expect(kinds(`class C { h() { return this.spaceService.createSpace(u, w, d); } }`)).toEqual(['createSpaceCall@C.h']);
    expect(kinds(`class A { s() { return this.signupService.initialSetup(d); } }`)).toEqual(['initialSetupCall@A.s']);
    expect(kinds(`class C { h() { return this.authService.setup(d); } }`)).toEqual(['authServiceSetupCall@C.h']);
    expect(kinds(`class C { constructor(private readonly spaces: SpaceService) {} }`)).toEqual([
      'spaceServiceInjection@C#spaces',
    ]);
  });

  it('attributes each occurrence to its enclosing method, so a NEW method in a listed file is caught', () => {
    const src = `class SpaceRepo {
      insertSpace(v) { return this.db.insertInto('spaces').values(v).execute(); }
      bulkInsert(vs) { return this.db.insertInto('spaces').values(vs).execute(); }
    }`;
    expect(kinds(src)).toEqual(['spacesRowInsert@SpaceRepo.insertSpace', 'spacesRowInsert@SpaceRepo.bulkInsert']);
  });

  it('the route tell sees the native create and not a longer identifier', () => {
    expect(NATIVE_SPACE_CREATE_CALL_RE.test('this.spaceService.createSpace(user, workspace.id, dto)')).toBe(true);
    expect(NATIVE_SPACE_CREATE_CALL_RE.test('this.spaceService.createSpace (user, id, dto)')).toBe(true);
    expect(NATIVE_SPACE_CREATE_CALL_RE.test('this.modal.createSpaceModal(x)')).toBe(false);
  });
});
