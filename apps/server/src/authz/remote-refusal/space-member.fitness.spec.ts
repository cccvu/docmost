import { readFileSync } from 'fs';
import { join } from 'path';
import * as ts from 'typescript';
import { literalText, ownerOf, sourceFiles } from '../route-guard/ast-sink-scan';
import { handlerCalls, scanRoutes } from '../route-guard/static-route-scan';
import { routesOf } from './remote-refusal.table';

/**
 * Native space-member writes FITNESS TEST (#636) — NOT upstream Docmost code.
 *
 * In remote mode the native `/api/spaces/members/{add,remove,change-role}` routes are gated by PDP-backed space CASL,
 * but nothing there stops a `space#administer` holder adding or raising themselves (or a group they are in) to a
 * direct admin row, which survives `- archived`. So remote refuses them (the `spaceMember` family) and the platform's
 * `/api/service/spaces/*` member routes are the governed path. This pins, statically (TS AST, no boot), that nothing
 * else reaches a `space_members` write — by OWNER METHOD, never by line:
 *  - the routes whose handler checks `SpaceCaslAction.Manage, SpaceCaslSubject.Member` are EXACTLY the refused keys;
 *  - every `space_members` row write (Kysely or raw SQL): the three upstream repo sink methods, the workspace member
 *    delete (`WorkspaceService.deleteUser`, reached only from the refused `WorkspaceController.deleteWorkspaceMember`)
 *    and the service bridge's member writes (`ServiceSpaceService`, behind RemoteOnlyGuard + ServiceAuthGuard);
 *  - every hop from the three repo sinks up to a route:
 *      insertSpaceMember ← SpaceMemberService.{addUserToSpace, addGroupToSpace, addMembersToSpaceBatch}
 *        addUserToSpace  ← SpaceService.createSpace (refused, #598) and the first-run WorkspaceService.create
 *                          (NativeAuthModeGuard 404s its route in remote; pinned in space-native-create.fitness.spec.ts)
 *        addGroupToSpace ← WorkspaceService.create (the same first-run path)
 *        addMembersToSpaceBatch ← SpaceController.addSpaceMember (refused)
 *      removeSpaceMemberById ← SpaceMemberService.removeMemberFromSpace ← SpaceController.removeSpaceMember (refused)
 *      updateSpaceMember ← SpaceMemberService.updateSpaceMemberRole ← SpaceController.updateSpaceMemberRole (refused)
 *  - the holders of an injected `SpaceMemberService`, so the name match above is sound.
 * A new method or route that reaches any hop fails RED, and whoever adds it decides whether remote must refuse it.
 * Row deletes by FK cascade (a deleted space or group) are the `spaceHardDelete` and `groupAdmin` families'.
 */
const SRC_ROOT = join(__dirname, '..', '..'); // .../apps/server/src

export const SPACE_MEMBER_MANAGE_RE = /\bSpaceCaslAction\s*\.\s*Manage\s*,\s*SpaceCaslSubject\s*\.\s*Member\b/;
// Raw SQL that writes a `space_members` row (not `space_members_view`, not trigger DDL such as `update or delete on`).
export const RAW_SPACE_MEMBERS_WRITE_RE =
  /\b(?:insert\s+into|update|delete\s+from)\s+(?:"?public"?\.)?"?space_members"?(?![\w"])/i;
// Kysely `insertInto/updateTable/deleteFrom('spaceMembers')`, camel or snake case, optionally aliased.
const SPACE_MEMBERS_TABLE_RE = /^(?:spaceMembers|space_members)(?:\s+as\s+\w+)?$/;
const KYSELY_WRITES = new Set(['insertInto', 'updateTable', 'deleteFrom']);

const HOPS = [
  'insertSpaceMember',
  'updateSpaceMember',
  'removeSpaceMemberById',
  'addUserToSpace',
  'addGroupToSpace',
  'addMembersToSpaceBatch',
  'removeMemberFromSpace',
  'updateSpaceMemberRole',
  'deleteUser',
] as const;
type Hop = (typeof HOPS)[number];
type SinkKind = 'spaceMembersRowWrite' | `${Hop}Call` | 'spaceMemberServiceInjection';
export interface SinkSite {
  kind: SinkKind;
  owner: string;
}

/** Every space-member write sink and hop in one source file, attributed to its enclosing method. Pure. */
export function scanSpaceMemberSinks(fileName: string, source: string): SinkSite[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const sites: SinkSite[] = [];
  const hops: ReadonlySet<string> = new Set(HOPS);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text;
      const first = node.arguments[0];
      if (KYSELY_WRITES.has(name) && first && SPACE_MEMBERS_TABLE_RE.test(literalText(first) ?? '')) {
        sites.push({ kind: 'spaceMembersRowWrite', owner: ownerOf(node) });
      }
      if (hops.has(name)) sites.push({ kind: `${name as Hop}Call`, owner: ownerOf(node) });
    }
    if (
      ts.isParameter(node) &&
      ts.isConstructorDeclaration(node.parent) &&
      node.type &&
      ts.isTypeReferenceNode(node.type) &&
      node.type.typeName.getText(sf) === 'SpaceMemberService' &&
      ts.isIdentifier(node.name)
    ) {
      sites.push({
        kind: 'spaceMemberServiceInjection',
        owner: `${ownerOf(node).replace(/\.constructor$/, '')}#${node.name.text}`,
      });
    }
    const text = literalText(node);
    if (text !== undefined && RAW_SPACE_MEMBERS_WRITE_RE.test(text)) {
      sites.push({ kind: 'spaceMembersRowWrite', owner: ownerOf(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

describe('native space-member writes are refused on every route that reaches them (#636)', () => {
  const routes = scanRoutes(SRC_ROOT);
  const key = (r: { controller: string; handler: string }) => `${r.controller}.${r.handler}`;
  const routeByKey = new Map(routes.map((r) => [key(r), r]));
  const files = sourceFiles(SRC_ROOT).map((full) => {
    const file = full.slice(SRC_ROOT.length + 1).split('\\').join('/');
    return { file, sinks: scanSpaceMemberSinks(file, readFileSync(full, 'utf8')) };
  });
  // Distinct `file:Owner.method` per kind: pinned by method, so a second write in a listed method is not a red.
  const ownersOf = (kind: SinkKind) => [
    ...new Set(files.flatMap((f) => f.sinks.filter((s) => s.kind === kind).map((s) => `${f.file}:${s.owner}`))),
  ].sort();

  it('scans a meaningful tree (guards against a silently-empty scan)', () => {
    expect(routes.length).toBeGreaterThanOrEqual(80);
    expect(files.length).toBeGreaterThanOrEqual(300);
    expect(files.some((f) => f.sinks.length > 0)).toBe(true);
  });

  it('the routes that check space Manage Member are EXACTLY the refused spaceMember keys', () => {
    const reaching = routes.filter((r) => handlerCalls(r, SPACE_MEMBER_MANAGE_RE)).map(key).sort();
    expect(reaching).toEqual([...routesOf('spaceMember')].sort());
  });

  it('every space_members row write is in a known owner method', () => {
    expect(ownersOf('spaceMembersRowWrite')).toEqual([
      'core/workspace/services/workspace.service.ts:WorkspaceService.deleteUser',
      'database/repos/space/space-member.repo.ts:SpaceMemberRepo.insertSpaceMember',
      'database/repos/space/space-member.repo.ts:SpaceMemberRepo.removeSpaceMemberById',
      'database/repos/space/space-member.repo.ts:SpaceMemberRepo.updateSpaceMember',
      'service-bridge/service-space.service.ts:ServiceSpaceService.addMember',
      'service-bridge/service-space.service.ts:ServiceSpaceService.changeMemberRole',
      'service-bridge/service-space.service.ts:ServiceSpaceService.create',
      'service-bridge/service-space.service.ts:ServiceSpaceService.createKeyed',
      'service-bridge/service-space.service.ts:ServiceSpaceService.removeMember',
    ]);
  });

  it('the three repo sinks are reached only through SpaceMemberService', () => {
    expect(ownersOf('insertSpaceMemberCall')).toEqual([
      'core/space/services/space-member.service.ts:SpaceMemberService.addGroupToSpace',
      'core/space/services/space-member.service.ts:SpaceMemberService.addMembersToSpaceBatch',
      'core/space/services/space-member.service.ts:SpaceMemberService.addUserToSpace',
    ]);
    expect(ownersOf('removeSpaceMemberByIdCall')).toEqual([
      'core/space/services/space-member.service.ts:SpaceMemberService.removeMemberFromSpace',
    ]);
    expect(ownersOf('updateSpaceMemberCall')).toEqual([
      'core/space/services/space-member.service.ts:SpaceMemberService.updateSpaceMemberRole',
    ]);
  });

  it('each SpaceMemberService write is reached only by a refused route or a create path pinned elsewhere', () => {
    expect(ownersOf('addMembersToSpaceBatchCall')).toEqual(['core/space/space.controller.ts:SpaceController.addSpaceMember']);
    expect(ownersOf('removeMemberFromSpaceCall')).toEqual([
      'core/space/space.controller.ts:SpaceController.removeSpaceMember',
    ]);
    expect(ownersOf('updateSpaceMemberRoleCall')).toEqual([
      'core/space/space.controller.ts:SpaceController.updateSpaceMemberRole',
    ]);
    // The creator's admin row on a new space: the refused native create (#598) and the first-run setup.
    expect(ownersOf('addUserToSpaceCall')).toEqual([
      'core/space/services/space.service.ts:SpaceService.createSpace',
      'core/workspace/services/workspace.service.ts:WorkspaceService.create',
    ]);
    expect(ownersOf('addGroupToSpaceCall')).toEqual(['core/workspace/services/workspace.service.ts:WorkspaceService.create']);
  });

  it('the workspace member delete (which deletes the user’s space_members rows) is reached only by a refused route', () => {
    expect(ownersOf('deleteUserCall')).toEqual([
      'core/workspace/controllers/workspace.controller.ts:WorkspaceController.deleteWorkspaceMember',
    ]);
    expect(routesOf('workspaceAdmin').has('WorkspaceController.deleteWorkspaceMember')).toBe(true);
  });

  it('the refused routes and the hops agree: every refused key reaches a member write', () => {
    for (const k of routesOf('spaceMember')) {
      const owners = [
        ...ownersOf('addMembersToSpaceBatchCall'),
        ...ownersOf('removeMemberFromSpaceCall'),
        ...ownersOf('updateSpaceMemberRoleCall'),
      ];
      expect([k, owners.some((o) => o.endsWith(`:${k}`))]).toEqual([k, true]);
    }
  });

  it('the service bridge member writes — the governed path — stay remote-only and service-authenticated', () => {
    for (const k of ['ServiceSpaceController.addMember', 'ServiceSpaceController.changeMemberRole', 'ServiceSpaceController.removeMember']) {
      expect(routeByKey.get(k)?.guardNames).toEqual(expect.arrayContaining(['RemoteOnlyGuard', 'ServiceAuthGuard']));
    }
  });

  it('SpaceMemberService is injected only where the name match expects it', () => {
    expect(ownersOf('spaceMemberServiceInjection')).toEqual([
      'core/space/services/space.service.ts:SpaceService#spaceMemberService',
      'core/space/space.controller.ts:SpaceController#spaceMemberService',
      'core/workspace/services/workspace.service.ts:WorkspaceService#spaceMemberService',
    ]);
  });
});

// The inventory is only as strong as the shapes the scanner recognizes. Pin them.
describe('the space-member sink scanner recognizes every sink shape (meta-guard)', () => {
  const kinds = (src: string) => scanSpaceMemberSinks('probe.ts', src).map((s) => `${s.kind}@${s.owner}`);

  it.each([
    [`class R { w(v) { return this.db.insertInto('spaceMembers').values(v).execute(); } }`],
    [`class R { w(v) { return this.db.updateTable("spaceMembers").set(v).execute(); } }`],
    ['class R { w() { return trx.deleteFrom(`spaceMembers`).execute(); } }'],
    [`class R { w() { return trx.deleteFrom('space_members as sm').execute(); } }`],
    ['class R { w(r) { return sql`update space_members set role = ${r}`.execute(this.db); } }'],
    ['class R { w(i) { const q = sql`DELETE FROM "space_members" WHERE id = ${i}`; return q; } }'],
    [`class R { w() { return this.pg.query('insert into public.space_members (user_id) values ($1)'); } }`],
  ])('flags a space_members row write: %s', (src) => {
    expect(kinds(src)).toEqual(['spaceMembersRowWrite@R.w']);
  });

  it.each([
    [`class R { r() { return this.db.selectFrom('spaceMembers').selectAll().execute(); } }`],
    [`const t = 'after insert or update or delete on space_members';`],
    [`const q = 'select * from space_members_view';`],
    [`const q = 'update space_members_archive set x = 1';`],
    [`// this.db.insertInto('spaceMembers')\n/* sql\`delete from space_members\` */ const x = 1;`],
    [`class R { w() { return this.db.insertInto('spaces').execute(); } }`],
  ])('does not flag %s', (src) => {
    expect(kinds(src)).toEqual([]);
  });

  it('sees every hop by exact name and the SpaceMemberService injection', () => {
    expect(kinds(`class S { a() { this.repo.insertSpaceMember(v); this.repo.updateSpaceMember(v, i, s); } }`)).toEqual([
      'insertSpaceMemberCall@S.a',
      'updateSpaceMemberCall@S.a',
    ]);
    expect(kinds(`class S { a() { return executeTx(db, async (trx) => this.repo.removeSpaceMemberById(i, s, { trx })); } }`)).toEqual([
      'removeSpaceMemberByIdCall@S.a',
    ]);
    expect(kinds(`class C { h() { return this.spaceMemberService.updateSpaceMemberRole(d, w); } }`)).toEqual([
      'updateSpaceMemberRoleCall@C.h',
    ]);
    expect(kinds(`class C { constructor(private readonly m: SpaceMemberService) {} }`)).toEqual([
      'spaceMemberServiceInjection@C#m',
    ]);
    expect(kinds(`class C { h() { this.repo.getSpaceMemberByTypeId(s, o); this.repo.insertSpaceMembers(v); } }`)).toEqual([]);
  });

  it('the route tell sees Manage Member only', () => {
    expect(SPACE_MEMBER_MANAGE_RE.test('ability.cannot(SpaceCaslAction.Manage, SpaceCaslSubject.Member)')).toBe(true);
    expect(SPACE_MEMBER_MANAGE_RE.test('ability.cannot(\n  SpaceCaslAction.Manage,\n  SpaceCaslSubject.Member,\n)')).toBe(true);
    expect(SPACE_MEMBER_MANAGE_RE.test('ability.cannot(SpaceCaslAction.Read, SpaceCaslSubject.Member)')).toBe(false);
    expect(SPACE_MEMBER_MANAGE_RE.test('ability.cannot(SpaceCaslAction.Manage, SpaceCaslSubject.Settings)')).toBe(false);
    expect(SPACE_MEMBER_MANAGE_RE.test('ability.cannot(SpaceCaslAction.Manage, SpaceCaslSubject.MemberX)')).toBe(false);
  });
});
