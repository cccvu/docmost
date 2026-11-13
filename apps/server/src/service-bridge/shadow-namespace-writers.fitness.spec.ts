import { readFileSync } from 'fs';
import { join } from 'path';
import * as ts from 'typescript';
import { literalText, ownerOf, sourceFiles } from '../authz/route-guard/ast-sink-scan';
import { scanRoutes } from '../authz/route-guard/static-route-scan';
import { ENTERPRISE_CODE_DIR, enterpriseCodePresent } from '../authz/mode/enterprise-code';
import { REMOTE_REFUSED_ROUTES, changesEmail } from '../authz/remote-refusal/remote-refusal.table';
import { SHADOW_EMAIL_DOMAIN, isShadowEmail } from './shadow-user';

/**
 * Shadow-namespace writers FITNESS TEST (wiki-v2 #871) — NOT upstream Docmost code.
 *
 * Since #871 the platform LINKS a Docmost user to the platform identity its email names when that email is in the
 * reserved shadow namespace (`<identityId>@shadow.wiki-v2.internal`, `shadow-user.ts` `externalIdOfShadow`, returned
 * by `WorkspaceResolver.resolveUser` as `externalId`). The namespace is therefore a TRUST ROOT: anyone who can put a
 * shadow-namespace email on a `users` row is named as that platform identity. That is sound only while, in remote
 * mode, the authenticated service bridge is the only thing that creates such a row, and nothing can change an
 * existing user's email into the namespace. This pins that statically (TS AST, no imports of the real services,
 * no boot), so an upstream bump or a new fork path that adds a writer goes RED here:
 *  (1) every `users` ROW INSERT (Kysely `insertInto('users')`, raw `INSERT INTO users`), per method and per
 *      occurrence, is `UserRepo.insertUser` or the bridge's `ServiceBridgeService.provisionShadowUser`;
 *  (2) every hop from `insertUser` up to a route, and what closes each route in remote mode:
 *        UserRepo.insertUser ← SignupService.signup ← AuthService.register ← (no caller)
 *                            ← SignupService.initialSetup ← AuthService.setup ← AuthController.setupWorkspace
 *                                                              (class-level NativeAuthModeGuard: 404 in remote)
 *                            ← WorkspaceInvitationService.acceptInvitation ← WorkspaceController.acceptInvite
 *                                                              (method-level NativeAuthModeGuard: 404 in remote)
 *      and the bridge's provision is called only from service-bridge code, every service-bridge route carrying
 *      RemoteOnlyGuard + ServiceAuthGuard;
 *  (3) every write that can set `users.email` on an EXISTING row: an `updateTable('users')` / `doUpdateSet` whose
 *      set object names `email` or cannot be read (a spread, a callback, a variable), raw `UPDATE users`, and every
 *      `.updateUser(` call that passes `email` or an unreadable patch. Today: `UserRepo.updateUser` (the generic
 *      patch), fed `email` only by `UserService.update` (the body of `/api/users/update`, whose `email` key the
 *      remote refusal table refuses, `userEmail` family) and `WorkspaceService.deleteUser` (a fixed
 *      `@deleted.docmost.com` tombstone, never the namespace; its route is refused too, `workspaceAdmin`);
 *  (4) `src/ee` holds no code (`enterprise-code.ts`, the boot refusal), which is what makes skipping `ee` sound.
 * Also: the shadow domain literal appears only in `shadow-user.ts`, and `shadowEmailFor` is called only from
 * service-bridge code, so nothing outside the bridge spells a namespace address.
 *
 * Existing pins this relies on rather than repeats: `native-auth-mode.guard.spec.ts` (the guard 404s an unmarked
 * route in remote), `native-credential-routes.spec.ts` (the session-scoped allowlist; `acceptInvite` guarded),
 * `remote-refusal.fitness.spec.ts` (each refused key is a real route; the interceptor registered once),
 * `remote-refusal.interceptor.spec.ts` (`changesEmail` refuses), `enterprise-code.spec.ts` / `.wiring.spec.ts`.
 * A static inventory: a write through an unrecognized indirection (a method passed by reference, a dynamic
 * property name, a builder split across statements before `.set`) is invisible, though a split `updateTable('users')`
 * with no `.set` in its chain is reported as unreadable (fail closed). The meta-guard at the bottom pins the shapes.
 */
const SRC_ROOT = join(__dirname, '..'); // .../apps/server/src

// Kysely table argument: `users` or `users as u`.
const USERS_TABLE_RE = /^users(?:\s+as\s+\w+)?$/;
// Raw SQL in a string or template literal. Not `user_tokens`, `users_x`, or trigger DDL (`update on users`).
export const RAW_USERS_INSERT_RE = /\b(?:insert|merge)\s+into\s+(?:"?public"?\.)?"?users"?(?![\w"])/i;
export const RAW_USERS_UPDATE_RE = /\bupdate\s+(?:"?public"?\.)?"?users"?\s+(?:as\s+\w+\s+)?set\b/i;

type SinkKind =
  | 'usersRowInsert'
  | 'usersEmailWrite'
  | 'insertUserCall'
  | 'updateUserEmailCall'
  | 'signupCall'
  | 'initialSetupCall'
  | 'authServiceSetupCall'
  | 'authServiceRegisterCall'
  | 'acceptInvitationCall'
  | 'userServiceUpdateCall'
  | 'provisionShadowUserCall'
  | 'shadowEmailForCall'
  | 'shadowDomainLiteral'
  | 'injection';
export interface SinkSite {
  kind: SinkKind;
  /** `Class.method` (`ownerOf`), with a `:detail` suffix where the kind carries one. */
  owner: string;
}

/** The receiver's LAST identifier: `this.authService.setup` → `authService`; `this.setup` → `this`. */
function receiverName(expr: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (ts.isIdentifier(expr)) return expr.text;
  if (expr.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  return undefined;
}

/** The outermost call of a fluent chain that starts at `call` (`db.updateTable(..).set(..).where(..).execute()`). */
function chainTop(call: ts.CallExpression): ts.Node {
  let cur: ts.Node = call;
  for (;;) {
    const p = cur.parent;
    if (p && ts.isPropertyAccessExpression(p) && p.expression === cur && p.parent && ts.isCallExpression(p.parent)) {
      cur = p.parent;
    } else return cur;
  }
}

/**
 * How a patch object treats `email`: `none` (an object literal that provably names no `email`), `email:<value>`
 * (it names it; `<value>` is `suffix:<literal>` for `expr + '<literal>'`, else `expr`), or `opaque` (a spread, a
 * computed key, or anything that is not an object literal — it could carry `email`).
 */
export function emailInPatch(arg: ts.Expression | undefined): string {
  while (arg && ts.isParenthesizedExpression(arg)) arg = arg.expression;
  // `cond ? {…} : {…}`: the worse of the two branches.
  if (arg && ts.isConditionalExpression(arg)) {
    const [a, b] = [emailInPatch(arg.whenTrue), emailInPatch(arg.whenFalse)];
    return a.startsWith('email:') ? a : b.startsWith('email:') ? b : a === 'opaque' || b === 'opaque' ? 'opaque' : 'none';
  }
  if (!arg || !ts.isObjectLiteralExpression(arg)) return 'opaque';
  let opaque = false;
  for (const p of arg.properties) {
    if (ts.isSpreadAssignment(p)) {
      // A spread of a readable literal (`...(named ? { name } : {})`) is read; anything else could carry `email`.
      const inner = emailInPatch(p.expression);
      if (inner.startsWith('email:')) return inner;
      if (inner === 'opaque') opaque = true;
      continue;
    }
    const name = p.name;
    if (!name || ts.isComputedPropertyName(name) || ts.isPrivateIdentifier(name)) {
      opaque = true;
      continue;
    }
    const key = ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : undefined;
    if (key !== 'email') continue;
    if (ts.isPropertyAssignment(p)) {
      const v = p.initializer;
      if (ts.isBinaryExpression(v) && v.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const suffix = literalText(v.right);
        if (suffix !== undefined) return `email:suffix:${suffix}`;
      }
    }
    return 'email:expr';
  }
  return opaque ? 'opaque' : 'none';
}

const INJECTED = new Set(['AuthService', 'UserService']);

/** Every users-row / email / chain-hop sink in one source file, attributed to its enclosing method. Pure. */
export function scanShadowNamespaceSinks(fileName: string, source: string): SinkSite[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const sites: SinkSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text;
      const receiver = receiverName(node.expression.expression);
      const first = node.arguments[0];
      const owner = ownerOf(node);
      const usersTable = first !== undefined && USERS_TABLE_RE.test(literalText(first) ?? '');
      if (usersTable && (name === 'insertInto' || name === 'mergeInto' || name === 'replaceInto')) {
        sites.push({ kind: 'usersRowInsert', owner });
      }
      if (usersTable && (name === 'insertInto' || name === 'updateTable' || name === 'mergeInto' || name === 'replaceInto')) {
        // Every `.set(` / `.doUpdateSet(` anywhere in the chain (an `onConflict` callback included).
        const writes: string[] = [];
        const find = (n: ts.Node): void => {
          if (
            ts.isCallExpression(n) &&
            ts.isPropertyAccessExpression(n.expression) &&
            (n.expression.name.text === 'set' || n.expression.name.text === 'doUpdateSet')
          ) {
            writes.push(emailInPatch(n.arguments[0]));
          }
          ts.forEachChild(n, find);
        };
        find(chainTop(node));
        // An update with no readable `.set` in its chain (a split builder) cannot be proven email-free.
        if (name === 'updateTable' && writes.length === 0) writes.push('opaque');
        for (const w of writes) if (w !== 'none') sites.push({ kind: 'usersEmailWrite', owner: `${owner}:${w}` });
      }
      if (name === 'insertUser') sites.push({ kind: 'insertUserCall', owner });
      if (name === 'updateUser') {
        const e = emailInPatch(first);
        if (e !== 'none') sites.push({ kind: 'updateUserEmailCall', owner: `${owner}:${e}` });
      }
      if (name === 'signup') sites.push({ kind: 'signupCall', owner });
      if (name === 'initialSetup') sites.push({ kind: 'initialSetupCall', owner });
      if (name === 'acceptInvitation') sites.push({ kind: 'acceptInvitationCall', owner });
      if (name === 'provisionShadowUser') sites.push({ kind: 'provisionShadowUserCall', owner });
      // Exact receiver identifiers (fastify's `app.register(` is not a hop); the injections below pin them.
      if (name === 'setup' && receiver === 'authService') sites.push({ kind: 'authServiceSetupCall', owner });
      if (name === 'register' && receiver === 'authService') sites.push({ kind: 'authServiceRegisterCall', owner });
      if (name === 'update' && receiver === 'userService') sites.push({ kind: 'userServiceUpdateCall', owner });
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'shadowEmailFor') {
      sites.push({ kind: 'shadowEmailForCall', owner: ownerOf(node) });
    }
    if (
      ts.isParameter(node) &&
      ts.isConstructorDeclaration(node.parent) &&
      node.type &&
      ts.isTypeReferenceNode(node.type) &&
      INJECTED.has(node.type.typeName.getText(sf)) &&
      ts.isIdentifier(node.name)
    ) {
      sites.push({
        kind: 'injection',
        owner: `${ownerOf(node).replace(/\.constructor$/, '')}#${node.name.text}:${node.type.typeName.getText(sf)}`,
      });
    }
    const text = literalText(node);
    if (text !== undefined) {
      if (RAW_USERS_INSERT_RE.test(text)) sites.push({ kind: 'usersRowInsert', owner: ownerOf(node) });
      if (RAW_USERS_UPDATE_RE.test(text)) sites.push({ kind: 'usersEmailWrite', owner: `${ownerOf(node)}:raw` });
      if (text.toLowerCase().includes(SHADOW_EMAIL_DOMAIN)) sites.push({ kind: 'shadowDomainLiteral', owner: ownerOf(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

describe('only the service bridge can put a shadow-namespace email on a users row in remote mode (#871)', () => {
  const routes = scanRoutes(SRC_ROOT);
  const key = (r: { controller: string; handler: string }) => `${r.controller}.${r.handler}`;
  const routeByKey = new Map(routes.map((r) => [key(r), r]));
  const files = sourceFiles(SRC_ROOT).map((full) => {
    const file = full.slice(SRC_ROOT.length + 1).split('\\').join('/');
    const src = readFileSync(full, 'utf8');
    return { file, src, sinks: scanShadowNamespaceSinks(file, src) };
  });
  // Every occurrence of a sink kind as `file:Owner.method[:detail]`, one entry per occurrence.
  const sitesOf = (kind: SinkKind) =>
    files.flatMap((f) => f.sinks.filter((s) => s.kind === kind).map((s) => `${f.file}:${s.owner}`)).sort();
  const deniedInRemote = (k: string) => {
    const r = routeByKey.get(k);
    expect(r).toBeDefined();
    expect(r!.guardNames).toContain('NativeAuthModeGuard');
    expect(r!.isSessionScopedRoute).toBe(false);
  };

  it('scans a meaningful tree (guards against a silently-empty scan)', () => {
    expect(routes.length).toBeGreaterThanOrEqual(80);
    expect(files.length).toBeGreaterThanOrEqual(300);
    expect(files.some((f) => f.file === 'database/repos/user/user.repo.ts')).toBe(true);
  });

  // (4) — first, because the scan skips `ee` and that is sound only while it is empty.
  it('src/ee holds no code, and it is the directory the scan skips (enterprise-code.ts boot refusal)', () => {
    expect(ENTERPRISE_CODE_DIR).toBe(join(SRC_ROOT, 'ee'));
    expect(enterpriseCodePresent(ENTERPRISE_CODE_DIR)).toBe(false);
  });

  // (1)
  it('every users row insert is UserRepo.insertUser or the bridge provision', () => {
    expect(sitesOf('usersRowInsert')).toEqual([
      'database/repos/user/user.repo.ts:UserRepo.insertUser',
      'service-bridge/service-bridge.service.ts:ServiceBridgeService.provisionShadowUser',
    ]);
  });

  // (2)
  it('`.insertUser(` is called only by signup, first-run setup and invite accept', () => {
    expect(sitesOf('insertUserCall')).toEqual([
      'core/auth/services/signup.service.ts:SignupService.initialSetup',
      'core/auth/services/signup.service.ts:SignupService.signup',
      'core/workspace/services/workspace-invitation.service.ts:WorkspaceInvitationService.acceptInvitation',
    ]);
  });

  it('signup is reached only by AuthService.register, which nothing calls', () => {
    expect(sitesOf('signupCall')).toEqual(['core/auth/services/auth.service.ts:AuthService.register']);
    expect(sitesOf('authServiceRegisterCall')).toEqual([]);
  });

  it('first-run setup ends at AuthController.setupWorkspace, which NativeAuthModeGuard 404s in remote', () => {
    expect(sitesOf('initialSetupCall')).toEqual(['core/auth/services/auth.service.ts:AuthService.setup']);
    expect(sitesOf('authServiceSetupCall')).toEqual(['core/auth/auth.controller.ts:AuthController.setupWorkspace']);
    deniedInRemote('AuthController.setupWorkspace');
  });

  it('invite accept ends at WorkspaceController.acceptInvite, which NativeAuthModeGuard 404s in remote', () => {
    expect(sitesOf('acceptInvitationCall')).toEqual([
      'core/workspace/controllers/workspace.controller.ts:WorkspaceController.acceptInvite',
    ]);
    deniedInRemote('WorkspaceController.acceptInvite');
  });

  it('the bridge provision is called only from service-bridge code, and every service-bridge route is remote-only and service-authenticated', () => {
    const callers = sitesOf('provisionShadowUserCall');
    expect(callers.length).toBeGreaterThanOrEqual(1);
    expect(callers.filter((c) => !c.startsWith('service-bridge/'))).toEqual([]);
    expect(callers).toContain('service-bridge/service-bridge.controller.ts:ServiceBridgeController.provisionUser');
    const bridgeRoutes = routes.filter((r) => r.file.split('\\').join('/').startsWith('service-bridge/'));
    expect(bridgeRoutes.length).toBeGreaterThanOrEqual(10);
    expect(
      bridgeRoutes
        .filter((r) => !r.guardNames.includes('RemoteOnlyGuard') || !r.guardNames.includes('ServiceAuthGuard'))
        .map(key),
    ).toEqual([]);
  });

  it('only shadow-user.ts spells the shadow domain, and only service-bridge code derives a shadow email', () => {
    expect(sitesOf('shadowDomainLiteral')).toEqual(['service-bridge/shadow-user.ts:<module>']);
    // Lookups (mint, resolve, deactivate, …) derive it too; the only one that WRITES is the provision insert (above).
    const derivers = sitesOf('shadowEmailForCall');
    expect(derivers).toContain('service-bridge/service-bridge.service.ts:ServiceBridgeService.provisionShadowUser');
    expect(derivers.filter((c) => !c.startsWith('service-bridge/'))).toEqual([]);
  });

  // (3)
  it('the only users write that can set email is UserRepo.updateUser’s generic patch', () => {
    expect(sitesOf('usersEmailWrite')).toEqual(['database/repos/user/user.repo.ts:UserRepo.updateUser:opaque']);
  });

  it('updateUser is fed email only by /api/users/update’s body and the member-delete tombstone', () => {
    expect(sitesOf('updateUserEmailCall')).toEqual([
      'core/user/user.service.ts:UserService.update:opaque',
      'core/workspace/services/workspace.service.ts:WorkspaceService.deleteUser:email:suffix:@deleted.docmost.com',
    ]);
    // The tombstone is a fixed domain, never the namespace.
    expect(isShadowEmail('00000000-0000-4000-8000-000000000000@deleted.docmost.com')).toBe(false);
  });

  it('UserService.update is reached only by UserController.updateUser, which remote mode refuses whenever the body names email', () => {
    expect(sitesOf('userServiceUpdateCall')).toEqual(['core/user/user.controller.ts:UserController.updateUser']);
    const r = routeByKey.get('UserController.updateUser');
    expect(r?.httpPath).toBe('/api/users/update');
    const hit = REMOTE_REFUSED_ROUTES.get('UserController.updateUser');
    expect(hit?.family.id).toBe('userEmail');
    expect(hit?.entry.when).toBe(changesEmail);
    expect(changesEmail({ email: `x@${SHADOW_EMAIL_DOMAIN}` })).toBe(true);
    expect(changesEmail({ email: null })).toBe(true);
    expect(changesEmail({ name: 'n' })).toBe(false);
  });

  it('the member delete (the tombstone writer) is refused in remote mode too', () => {
    const deleting = routes.filter((r) => /\.deleteUser\s*\(/.test(r.handlerText)).map(key);
    expect(deleting).toEqual(['WorkspaceController.deleteWorkspaceMember']);
    expect(REMOTE_REFUSED_ROUTES.get('WorkspaceController.deleteWorkspaceMember')?.family.id).toBe('workspaceAdmin');
  });

  it('AuthService and UserService are injected only where the receiver-name match expects them', () => {
    expect(sitesOf('injection')).toEqual([
      'core/auth/auth.controller.ts:AuthController#authService:AuthService',
      'core/user/user.controller.ts:UserController#userService:UserService',
    ]);
  });
});

// The inventory is only as strong as the shapes the scanner recognizes. Pin them.
describe('the shadow-namespace sink scanner recognizes every sink shape (meta-guard)', () => {
  const kinds = (src: string) => scanShadowNamespaceSinks('probe.ts', src).map((s) => `${s.kind}@${s.owner}`);

  it.each([
    [`class R { i(v) { return this.db.insertInto('users').values(v).execute(); } }`],
    [`class R { i(v) { return this.db.insertInto("users").values(v).execute(); } }`],
    ['class R { i(v) { return trx.insertInto(`users`).values(v).execute(); } }'],
    [`class R { i(v) { return this.db.insertInto('users as u').values(v).execute(); } }`],
    ['class R { i(e) { return sql`INSERT INTO users (email) VALUES (${e})`.execute(this.db); } }'],
    [`class R { i() { return this.pg.query('insert into "users" (email) values ($1)'); } }`],
    [`class R { i() { return this.pg.query('insert into public.users (email) values ($1)'); } }`],
  ])('flags a users-row insert: %s', (src) => {
    expect(kinds(src)).toEqual(['usersRowInsert@R.i']);
  });

  it.each([
    [`class R { i(v) { return this.db.insertInto('userTokens').values(v).execute(); } }`],
    [`const q = 'insert into user_tokens (user_id) values ($1)';`],
    [`const q = 'insert into users_archive (id) values ($1)';`],
    [`const t = 'after insert or update on users for each row';`],
    [`// this.db.insertInto('users')\n/* sql\`insert into users\` */ const x = 1;`],
    [`class R { u() { return this.db.updateTable('users').set({ role: 'member', updatedAt: new Date() }).execute(); } }`],
    [`class S { a() { return this.userRepo.updateUser({ deactivatedAt: null }, id, ws); } }`],
  ])('does not flag %s', (src) => {
    expect(kinds(src)).toEqual([]);
  });

  it.each([
    [`class R { u(e) { return this.db.updateTable('users').set({ email: e }).execute(); } }`, 'email:expr'],
    [`class R { u(e) { return this.db.updateTable('users').set({ 'email': e }).execute(); } }`, 'email:expr'],
    [`class R { u(email) { return this.db.updateTable('users').set({ email }).execute(); } }`, 'email:expr'],
    [`class R { u(p) { return this.db.updateTable('users').set({ ...p, updatedAt: 1 }).execute(); } }`, 'opaque'],
    [`class R { u(p) { return this.db.updateTable('users').set(p).execute(); } }`, 'opaque'],
    [`class R { u(k, v) { return this.db.updateTable('users').set({ [k]: v }).execute(); } }`, 'opaque'],
    [`class R { u() { return this.db.updateTable('users as u').set((eb) => ({ email: 'x' })).execute(); } }`, 'opaque'],
    [`class R { u() { const q = this.db.updateTable('users'); return q.set({ email: 'x' }).execute(); } }`, 'opaque'],
    [
      `class R { u(v) { return this.db.insertInto('users').values(v).onConflict((oc) => oc.column('id').doUpdateSet({ email: v.email })).execute(); } }`,
      'email:expr',
    ],
    ['class R { u(e) { return sql`UPDATE users SET email = ${e}`.execute(this.db); } }', 'raw'],
    [`class R { u() { return this.pg.query('update "users" set email = $1'); } }`, 'raw'],
  ])('flags a users email write: %s', (src, detail) => {
    expect(kinds(src).filter((k) => k.startsWith('usersEmailWrite'))).toEqual([`usersEmailWrite@R.u:${detail}`]);
  });

  it('classifies updateUser patches', () => {
    expect(kinds(`class S { a(e) { this.userRepo.updateUser({ email: e }, id, ws); } }`)).toEqual([
      'updateUserEmailCall@S.a:email:expr',
    ]);
    expect(kinds(`class S { a() { this.userRepo.updateUser({ email: v4() + '@x.test' }, id, ws); } }`)).toEqual([
      'updateUserEmailCall@S.a:email:suffix:@x.test',
    ]);
    expect(kinds(`class S { a(dto) { this.userRepo.updateUser(dto, id, ws); } }`)).toEqual(['updateUserEmailCall@S.a:opaque']);
    expect(kinds(`class S { a(d) { this.userRepo.updateUser({ ...d }, id, ws); } }`)).toEqual(['updateUserEmailCall@S.a:opaque']);
    expect(kinds(`class S { a(n) { this.userRepo.updateUser({ ...(n ? { name: n } : {}), role: 'member' }, id, ws); } }`)).toEqual([]);
    expect(kinds(`class S { a(e) { this.userRepo.updateUser({ ...(e ? { email: e } : {}) }, id, ws); } }`)).toEqual([
      'updateUserEmailCall@S.a:email:expr',
    ]);
    expect(kinds(`class S { a(e, p) { this.userRepo.updateUser({ ...(e ? p : {}) }, id, ws); } }`)).toEqual([
      'updateUserEmailCall@S.a:opaque',
    ]);
  });

  it('sees every chain hop, the injections and the namespace spellings', () => {
    expect(kinds(`class S { c() { return this.userRepo.insertUser(v, trx); } }`)).toEqual(['insertUserCall@S.c']);
    expect(kinds(`class A { r() { return this.signupService.signup(d, w); } }`)).toEqual(['signupCall@A.r']);
    expect(kinds(`class A { s() { return this.signupService.initialSetup(d); } }`)).toEqual(['initialSetupCall@A.s']);
    expect(kinds(`class C { h() { return this.authService.setup(d); } }`)).toEqual(['authServiceSetupCall@C.h']);
    expect(kinds(`class C { h() { return this.authService.register(d, w); } }`)).toEqual(['authServiceRegisterCall@C.h']);
    expect(kinds(`class C { h() { return app.register(fastifyCookie); } }`)).toEqual([]);
    expect(kinds(`class C { h() { return this.userService.update(d, u, w); } }`)).toEqual(['userServiceUpdateCall@C.h']);
    expect(kinds(`class C { h() { return this.svc.acceptInvitation(d, w); } }`)).toEqual(['acceptInvitationCall@C.h']);
    expect(kinds(`class C { h() { return this.bridge.provisionShadowUser({ externalId }); } }`)).toEqual([
      'provisionShadowUserCall@C.h',
    ]);
    expect(kinds(`class C { h(id) { return shadowEmailFor(id); } }`)).toEqual(['shadowEmailForCall@C.h']);
    expect(kinds(`class C { h(id) { return id + '@Shadow.Wiki-v2.Internal'; } }`)).toEqual(['shadowDomainLiteral@C.h']);
    expect(kinds(`class C { constructor(private readonly auth: AuthService, private u: UserService) {} }`)).toEqual([
      'injection@C#auth:AuthService',
      'injection@C#u:UserService',
    ]);
  });

  it('attributes each occurrence to its enclosing method, so a NEW method in a listed file is caught', () => {
    const src = `class UserRepo {
      insertUser(v) { return this.db.insertInto('users').values(v).execute(); }
      bulkInsert(vs) { return this.db.insertInto('users').values(vs).execute(); }
    }`;
    expect(kinds(src)).toEqual(['usersRowInsert@UserRepo.insertUser', 'usersRowInsert@UserRepo.bulkInsert']);
  });
});
