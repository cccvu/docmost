import { Logger } from '@nestjs/common';
import { User } from '@docmost/db/types/entity.types';
import SpaceAbilityFactory from '../../core/casl/abilities/space-ability.factory';
import { spyKysely } from '../../service-bridge/kysely-spy.testkit';
import { refusalCodeOf } from '../../service-bridge/resource-version';
import { PageRestrictionService } from './page-restriction.service';
import { PageRestrictionController } from './page-restriction.controller';
import { AddPagePermissionDto, RestrictionPreviewDto, UpdatePagePermissionDto } from './dto';
import { ACL_ADMIN_OVERRIDE_EVENT, ACL_WRITE_REFUSED_EVENT, AUDITED_ACL_REFUSALS } from './acl-audit';
import { roleCovers } from './grant-ceiling';

/**
 * #797 — the restricted-page grant ceilings, at the unit level (page-grant-ceiling.pg.spec.ts proves the SQL, the fence
 * against a real outbox, and the race on a real engine):
 *   - INV-4 (A4): granting reader needs the acting human's page `view`, granting writer (add, or an update that raises)
 *     needs page `edit`, or the workspace-admin disjunct — as a matrix over the actor's access × role × add/update ×
 *     real/preview × the native body / the platform relay's body (the fork cannot tell them apart: both reach the same
 *     controller as the human);
 *   - a refusal is 403 `grant_exceeds_actor`, audited `page.acl_write_refused`; a grant that passes ONLY through the
 *     admin disjunct is audited `page.acl_admin_override_grant` + the `PAGE_ACL_ADMIN_OVERRIDE` log token, and nothing
 *     else is;
 *   - the actor's own rows decide first (no fence); the PDP's page answer is asked only after the settle fence, read
 *     under the lock and before any write; a PDP or fence failure is a 503 (never a pass for a non-admin);
 *   - the admin disjunct is decided on the HUMAN only, never intersected with a service-account leg (the recorded
 *     exception to the #617 intersection rule);
 *   - INV-6: a group subject is refused on add and on a raise (real and preview, both bodies); a grandfathered group
 *     grant counts as the actor's own access, and can be lowered, left as it is, or removed.
 */
const PAGE_ID = '11111111-1111-4111-8111-111111111111';
const SPACE_ID = '22222222-2222-4222-8222-222222222222';
const WS_ID = '33333333-3333-4333-8333-333333333333';
const ACTOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TARGET = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const GROUP = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ACTOR_GROUP = 'abababab-abab-4bab-8bab-abababababab';
const ACCESS_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

/**
 * What the actor holds on the restricted page:
 *   view / edit — their own reader / writer grant row;          bview / bedit — no row; the settled PDP answers
 *   none — a space admin with no access to the page;            page view / view+edit (a page-scoped role binding);
 *   cascade — no row, no page access; a workspace admin.
 */
type Access = 'view' | 'edit' | 'none' | 'cascade' | 'bview' | 'bedit';
type Grant = { userId: string | null; groupId: string | null; role: string };

interface World {
  access?: Access;
  mode?: 'native' | 'remote';
  /** Grants on the page besides the actor's own (TARGET's, for an update). */
  grants?: Grant[];
  /** Group ids the actor belongs to (the `group_users` probe). */
  actorGroups?: string[];
  /** `space#view` + `admin_cascade` answer (null = the PDP failed). Defaults from `access`. */
  inputs?: [boolean, boolean] | null;
  /** The settled page check's answer (null = the PDP failed). Defaults from `access`. */
  pageCheck?: boolean | null;
  /** The settle fence's answer. */
  settle?: { status: 'confirmed' } | { status: 'pending'; reason: string };
  /** The native workspace role (native mode's admin disjunct). */
  userRole?: string;
}

function make(w: World = {}) {
  const access = w.access ?? 'edit';
  const mode = w.mode ?? 'remote';
  const own: Grant[] =
    access === 'view'
      ? [{ userId: ACTOR, groupId: null, role: 'reader' }]
      : access === 'edit'
        ? [{ userId: ACTOR, groupId: null, role: 'writer' }]
        : [];
  // The page's grants — mutated by the writes below, so the post-write ACL read sees the write's effect.
  let grants: Grant[] = [...own, ...(w.grants ?? [])];
  const order: string[] = [];
  const spy = spyKysely((q) => {
    if (q.sql.includes('pg_advisory_xact_lock')) order.push('lock');
    if (q.sql.includes('from page_access pa left join page_permissions')) {
      order.push('acl');
      return grants.length
        ? grants.map((g) => ({ accessId: ACCESS_ID, ...g }))
        : [{ accessId: ACCESS_ID, userId: null, groupId: null, role: null }];
    }
    if (q.sql.includes('from authz_outbox')) {
      order.push('fence-position');
      return [{ xactId: '900', id: '7' }];
    }
    if (q.sql.includes('from "group_users"')) {
      const asked = q.parameters.slice(1) as string[];
      return (w.actorGroups ?? []).filter((g) => asked.includes(g)).map((groupId) => ({ groupId }));
    }
    if (q.sql.includes('from "page_permissions"')) {
      const g = grants.find((x) => x.userId === TARGET || x.groupId === GROUP);
      return g ? [{ id: 'perm-1', role: g.role }] : [];
    }
    if (/^(update|delete|insert)/.test(q.sql)) order.push('write');
    if (q.sql.startsWith('update "page_permissions" set "role"')) {
      const role = q.parameters[0] as string;
      grants = grants.map((g) => (g.userId === TARGET || g.groupId === GROUP ? { ...g, role } : g));
    }
    return [];
  });
  const repo = {
    findPageAccessByPageId: jest.fn(async () => ({ id: ACCESS_ID })),
    insertPagePermissions: jest.fn(async (rows: Array<{ userId?: string; groupId?: string; role: string }>) => {
      order.push('write');
      grants = [...grants, ...rows.map((r) => ({ userId: r.userId ?? null, groupId: r.groupId ?? null, role: r.role }))];
    }),
    deletePagePermissionsByUserIds: jest.fn(async (_a: string, ids: string[]) => {
      order.push('write');
      grants = grants.filter((g) => !g.userId || !ids.includes(g.userId));
    }),
    deletePagePermissionsByGroupIds: jest.fn(async (_a: string, ids: string[]) => {
      order.push('write');
      grants = grants.filter((g) => !g.groupId || !ids.includes(g.groupId));
    }),
  };
  const spaceView = true; // every actor here can see the space (a workspace admin through admin_cascade)
  const admin = access === 'cascade';
  const pageView = access === 'view' || access === 'edit' || access === 'bview' || access === 'bedit';
  const pageEdit = access === 'edit' || access === 'bedit';
  const authz = {
    tryCheckBulk: jest.fn(async (_s: unknown, checks: Array<{ permission: string; resourceType: string }>) => {
      if (checks.length === 1 && checks[0].permission === 'administer') return [true]; // the space-admin gate
      if (checks.some((c) => c.permission === 'admin_cascade')) {
        order.push('inputs');
        return w.inputs === undefined ? [spaceView, admin] : w.inputs;
      }
      if (checks.length === 1 && checks[0].resourceType === 'page') {
        order.push(`page#${checks[0].permission}`);
        if (w.pageCheck !== undefined) return w.pageCheck === null ? null : [w.pageCheck];
        return [checks[0].permission === 'edit' ? pageEdit : pageView];
      }
      throw new Error(`unexpected PDP read ${JSON.stringify(checks)}`);
    }),
    settleProjection: jest.fn(async () => {
      order.push('settle');
      return w.settle ?? { status: 'confirmed' as const };
    }),
  };
  const audit = { log: jest.fn() };
  const spaceAbility = new SpaceAbilityFactory({
    getUserSpaceRoles: async () => [{ userId: ACTOR, role: 'admin' }],
  } as never);
  const service = new PageRestrictionService(
    spy.db,
    { findById: jest.fn(async () => ({ id: PAGE_ID, spaceId: SPACE_ID, workspaceId: WS_ID })) } as never,
    repo as never,
    spaceAbility,
    mode,
    authz as never,
    undefined,
    audit as never,
  );
  const controller = new PageRestrictionController(service);
  const user = { id: ACTOR, role: w.userRole } as unknown as User;
  const auditEvents = () => audit.log.mock.calls.map((c) => (c[0] as { event: string }).event);
  return { service, controller, spy, repo, authz, audit, auditEvents, order, user };
}

type Op = 'add' | 'update';
type Path = 'real' | 'preview';
/** `native`: the body the wiki's own client sends; `relay`: the exact body `AclService` (platform) relays. */
type Body = 'native' | 'relay';

const TARGET_READER: Grant = { userId: TARGET, groupId: null, role: 'reader' };

/** Run one grant through the controller (the route both the wiki client and the platform relay reach). */
async function run(m: ReturnType<typeof make>, op: Op, role: 'reader' | 'writer', path: Path, body: Body) {
  const relayExtra = body === 'relay' ? { expectedVersion: '*' } : {};
  if (path === 'preview') {
    const dto =
      op === 'add'
        ? { pageId: PAGE_ID, action: 'add', role, userIds: [TARGET], ...relayExtra }
        : { pageId: PAGE_ID, action: 'update', role, userId: TARGET, ...relayExtra };
    return m.controller.restrictionPreview(dto as RestrictionPreviewDto, m.user);
  }
  return op === 'add'
    ? m.controller.addPermission({ pageId: PAGE_ID, role, userIds: [TARGET], ...relayExtra } as AddPagePermissionDto, m.user)
    : m.controller.updatePermission({ pageId: PAGE_ID, role, userId: TARGET, ...relayExtra } as UpdatePagePermissionDto, m.user);
}

/** The expected INV-4 outcome: `grant` / `page_access` / `override` pass; `refused` is 403 grant_exceeds_actor. */
function expected(access: Access, role: 'reader' | 'writer'): 'grant' | 'page_access' | 'override' | 'refused' {
  if (access === 'cascade') return 'override';
  if (role === 'reader') {
    if (access === 'view' || access === 'edit') return 'grant';
    if (access === 'bview' || access === 'bedit') return 'page_access';
    return 'refused';
  }
  if (access === 'edit') return 'grant';
  if (access === 'bedit') return 'page_access';
  return 'refused';
}

describe('INV-4 (#797): a grant never exceeds the acting human — the matrix', () => {
  const accesses: Access[] = ['view', 'edit', 'none', 'cascade', 'bview', 'bedit'];
  const cells: Array<[Access, 'reader' | 'writer', Op, Path, Body]> = [];
  for (const a of accesses)
    for (const role of ['reader', 'writer'] as const)
      for (const op of ['add', 'update'] as const)
        for (const path of ['real', 'preview'] as const)
          for (const body of ['native', 'relay'] as const) {
            if (op === 'update' && role === 'reader') continue; // a reader update never raises: covered below
            cells.push([a, role, op, path, body]);
          }

  it.each(cells)('actor %s · grant %s · %s · %s · %s body', async (access, role, op, path, body) => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const m = make({ access, grants: op === 'update' ? [TARGET_READER] : [] });
      const want = expected(access, role);
      const res = await run(m, op, role, path, body).catch((e) => e);
      const action = op;
      if (want === 'refused') {
        if (path === 'preview') {
          expect(res).toMatchObject({ outcome: 'refused', code: 'grant_exceeds_actor' });
          expect(m.audit.log).not.toHaveBeenCalled();
        } else {
          expect(res).toMatchObject({ status: 403, response: { code: 'grant_exceeds_actor' } });
          expect(refusalCodeOf(res)).toBe('grant_exceeds_actor');
          expect(m.audit.log).toHaveBeenCalledTimes(1);
          expect(m.audit.log).toHaveBeenCalledWith({
            event: ACL_WRITE_REFUSED_EVENT,
            resourceType: 'page',
            resourceId: PAGE_ID,
            spaceId: SPACE_ID,
            metadata: { surface: 'engine', outcome: 'denied', action, reason: 'grant_exceeds_actor' },
          });
        }
        expect(m.order).not.toContain('write'); // nothing was written
        expect(m.spy.tx).toEqual(['begin', 'rollback']);
        return;
      }
      if (path === 'preview') {
        expect(res).toMatchObject({ outcome: 'would_apply' });
        expect(m.audit.log).not.toHaveBeenCalled(); // a preview audits nothing, override included
        expect(m.spy.tx).toEqual(['begin', 'rollback']);
        return;
      }
      expect(res).toMatchObject({ success: true, version: expect.any(String) });
      expect(m.spy.tx).toEqual(['begin', 'commit']);
      const overridden = m.auditEvents().filter((e) => e === ACL_ADMIN_OVERRIDE_EVENT);
      expect(overridden).toHaveLength(want === 'override' ? 1 : 0);
      const tokens = warn.mock.calls.filter((c) => String(c[0]).startsWith('PAGE_ACL_ADMIN_OVERRIDE '));
      expect(tokens).toHaveLength(want === 'override' ? 1 : 0);
    } finally {
      warn.mockRestore();
    }
  });

  it('the matrix is not vacuous: every outcome occurs, on both bodies and both paths', () => {
    const outcomes = new Set(cells.map(([a, r]) => expected(a, r)));
    expect([...outcomes].sort()).toEqual(['grant', 'override', 'page_access', 'refused']);
    expect(cells.length).toBe(6 * 2 * 2 * 3); // 6 accesses × 2 paths × 2 bodies × (add reader, add writer, update raise)
  });

  it.each<[Access]>([['none'], ['view'], ['cascade']])(
    'a reader update (a lowering or a no-op) is never ceiling-checked: actor %s, writer → reader applies, no PDP ceiling read',
    async (access) => {
      const m = make({ access, grants: [{ ...TARGET_READER, role: 'writer' }] });
      await expect(
        m.controller.updatePermission({ pageId: PAGE_ID, role: 'reader', userId: TARGET } as UpdatePagePermissionDto, m.user),
      ).resolves.toMatchObject({ success: true });
      expect(m.order).not.toContain('inputs');
      expect(m.authz.settleProjection).not.toHaveBeenCalled();
      expect(m.auditEvents()).not.toContain(ACL_ADMIN_OVERRIDE_EVENT);
    },
  );

  it('roleCovers: reader ⇐ reader|writer, writer ⇐ writer only, nothing ⇐ none', () => {
    expect(roleCovers('reader', 'reader')).toBe(true);
    expect(roleCovers('writer', 'reader')).toBe(true);
    expect(roleCovers('writer', 'writer')).toBe(true);
    expect(roleCovers('reader', 'writer')).toBe(false);
    expect(roleCovers(null, 'reader')).toBe(false);
    expect(roleCovers('owner', 'reader')).toBe(false);
  });

  it('grant_exceeds_actor is an audited refusal', () => {
    expect(AUDITED_ACL_REFUSALS.has('grant_exceeds_actor')).toBe(true);
  });
});

describe('INV-4 (#797): how it is decided', () => {
  it('the actor’s own row decides under the lock: no fence and no page-level PDP read', async () => {
    const m = make({ access: 'edit' });
    await m.service.addPermission({ pageId: PAGE_ID, role: 'writer', userIds: [TARGET] } as AddPagePermissionDto, m.user);
    expect(m.authz.settleProjection).not.toHaveBeenCalled();
    expect(m.order.filter((o) => o.startsWith('page#'))).toEqual([]);
    expect(m.order.indexOf('inputs')).toBeLessThan(m.order.indexOf('lock')); // the inputs are read before the lock
  });

  it('a grandfathered group grant the actor is in counts as their own access (no fence)', async () => {
    const m = make({ access: 'none', grants: [{ userId: null, groupId: ACTOR_GROUP, role: 'writer' }], actorGroups: [ACTOR_GROUP] });
    await expect(
      m.service.addPermission({ pageId: PAGE_ID, role: 'writer', userIds: [TARGET] } as AddPagePermissionDto, m.user),
    ).resolves.toMatchObject({ version: expect.any(String) });
    expect(m.authz.settleProjection).not.toHaveBeenCalled();
  });

  it('a group grant the actor is NOT in does not count', async () => {
    const m = make({ access: 'none', grants: [{ userId: null, groupId: ACTOR_GROUP, role: 'writer' }], actorGroups: [] });
    await expect(
      m.service.addPermission({ pageId: PAGE_ID, role: 'reader', userIds: [TARGET] } as AddPagePermissionDto, m.user),
    ).rejects.toMatchObject({ status: 403, response: { code: 'grant_exceeds_actor' } });
  });

  it('the page-level read comes only AFTER the fence, which is read under the lock after the ACL and before any write', async () => {
    const m = make({ access: 'bview' });
    await m.service.addPermission({ pageId: PAGE_ID, role: 'reader', userIds: [TARGET] } as AddPagePermissionDto, m.user);
    expect(m.order).toEqual(['inputs', 'lock', 'acl', 'fence-position', 'settle', 'page#view', 'write', 'write', 'write', 'acl']);
    expect(m.authz.settleProjection).toHaveBeenCalledWith('900.7', expect.any(Number));
  });

  it('a local row that covers but no space#view is not enough (page access needs the space): refused without a fence', async () => {
    const m = make({ access: 'edit', inputs: [false, false] });
    await expect(
      m.service.addPermission({ pageId: PAGE_ID, role: 'reader', userIds: [TARGET] } as AddPagePermissionDto, m.user),
    ).rejects.toMatchObject({ status: 403, response: { code: 'grant_exceeds_actor' } });
    expect(m.authz.settleProjection).not.toHaveBeenCalled();
  });

  it('the inputs read failing is a 503 before any transaction', async () => {
    const m = make({ access: 'edit', inputs: null });
    await expect(
      m.service.addPermission({ pageId: PAGE_ID, role: 'reader', userIds: [TARGET] } as AddPagePermissionDto, m.user),
    ).rejects.toMatchObject({ status: 503 });
    expect(m.spy.tx).toEqual([]);
    expect(m.audit.log).not.toHaveBeenCalled();
  });

  it('a malformed inputs answer (wrong length) is a 503, never a pass', async () => {
    const m = make({ access: 'cascade', inputs: [true] as never });
    await expect(
      m.service.addPermission({ pageId: PAGE_ID, role: 'reader', userIds: [TARGET] } as AddPagePermissionDto, m.user),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('an unconfirmed fence is a 503 grant_ceiling_unconfirmed for a non-admin (logged), with nothing written — and a preview answers the same 503', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const m = make({ access: 'bview', settle: { status: 'pending', reason: 'timeout' } });
      await expect(
        m.service.addPermission({ pageId: PAGE_ID, role: 'reader', userIds: [TARGET] } as AddPagePermissionDto, m.user),
      ).rejects.toMatchObject({ status: 503, response: { code: 'grant_ceiling_unconfirmed' } });
      expect(m.order).not.toContain('write');
      expect(m.order.filter((o) => o.startsWith('page#'))).toEqual([]); // never decided on the stale PDP
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('PAGE_ACL_CEILING_UNCONFIRMED reason=timeout'));
      expect(m.audit.log).not.toHaveBeenCalled();
      const p = make({ access: 'bview', settle: { status: 'pending', reason: 'timeout' } });
      await expect(
        p.service.preview({ pageId: PAGE_ID, action: 'add', role: 'reader', userIds: [TARGET] } as RestrictionPreviewDto, p.user),
      ).rejects.toMatchObject({ status: 503, response: { code: 'grant_ceiling_unconfirmed' } });
    } finally {
      warn.mockRestore();
    }
  });

  it('the page check failing is a 503 for a non-admin', async () => {
    const m = make({ access: 'bview', pageCheck: null });
    await expect(
      m.service.addPermission({ pageId: PAGE_ID, role: 'reader', userIds: [TARGET] } as AddPagePermissionDto, m.user),
    ).rejects.toMatchObject({ status: 503 });
    expect(m.order).not.toContain('write');
  });

  it('a disabled fence (0) proves nothing: 403 for a non-admin, nothing asked', async () => {
    const prev = process.env.AUTHZ_NARROWING_SETTLE_TIMEOUT_MS;
    process.env.AUTHZ_NARROWING_SETTLE_TIMEOUT_MS = '0';
    try {
      const m = make({ access: 'bview' });
      await expect(
        m.service.addPermission({ pageId: PAGE_ID, role: 'reader', userIds: [TARGET] } as AddPagePermissionDto, m.user),
      ).rejects.toMatchObject({ status: 403, response: { code: 'grant_exceeds_actor' } });
      expect(m.authz.settleProjection).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.AUTHZ_NARROWING_SETTLE_TIMEOUT_MS;
      else process.env.AUTHZ_NARROWING_SETTLE_TIMEOUT_MS = prev;
    }
  });
});

describe('INV-4 (#797): the admin override audit — only when the admin disjunct ALONE grants', () => {
  const add = (m: ReturnType<typeof make>, role: 'reader' | 'writer' = 'reader') =>
    m.service.addPermission({ pageId: PAGE_ID, role, userIds: [TARGET] } as AddPagePermissionDto, m.user);
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it('cascade only: the write row AND one override row (ids and roles only), plus the log token', async () => {
    const m = make({ access: 'cascade' });
    await add(m, 'writer');
    expect(m.auditEvents()).toEqual(['page.permission_added', ACL_ADMIN_OVERRIDE_EVENT]);
    expect(m.audit.log.mock.calls[1][0]).toEqual({
      event: ACL_ADMIN_OVERRIDE_EVENT,
      resourceType: 'page',
      resourceId: PAGE_ID,
      spaceId: SPACE_ID,
      metadata: {
        surface: 'engine',
        outcome: 'allowed',
        basis: 'admin_cascade',
        action: 'add',
        role: 'writer',
        grantees: [{ userId: TARGET, role: 'writer' }],
      },
    });
    expect(warn).toHaveBeenCalledWith(
      `PAGE_ACL_ADMIN_OVERRIDE action=add page=${PAGE_ID} space=${SPACE_ID} role=writer grantees=1`,
    );
  });

  it('an admin who also holds their own grant: no override row (the grant is theirs to share)', async () => {
    const m = make({ access: 'edit', inputs: [true, true] });
    await add(m, 'writer');
    expect(m.auditEvents()).toEqual(['page.permission_added']);
  });

  it('an admin whose settled page access covers it (a page binding): no override row', async () => {
    const m = make({ access: 'cascade', pageCheck: true });
    await add(m);
    expect(m.auditEvents()).toEqual(['page.permission_added']);
  });

  it('an admin whose page access cannot be proven (fence pending, or the page check failed): applied, audited as an override marked unconfirmed', async () => {
    for (const w of [{ settle: { status: 'pending' as const, reason: 'timeout' } }, { pageCheck: null }]) {
      const m = make({ access: 'cascade', ...w });
      await add(m);
      expect(m.auditEvents()).toEqual(['page.permission_added', ACL_ADMIN_OVERRIDE_EVENT]);
      expect(m.audit.log.mock.calls[1][0].metadata).toMatchObject({ pageAccess: 'unconfirmed' });
    }
  });

  it('an override that changes nothing (the grantee already holds the role) emits no row', async () => {
    const m = make({ access: 'cascade', grants: [TARGET_READER] });
    await add(m);
    expect(m.audit.log).not.toHaveBeenCalled();
  });

  it('a raise through the override is audited with the changed grantee', async () => {
    const m = make({ access: 'cascade', grants: [TARGET_READER] });
    await m.service.updatePermission({ pageId: PAGE_ID, role: 'writer', userId: TARGET } as UpdatePagePermissionDto, m.user);
    expect(m.auditEvents()).toEqual(['page.permission_added', ACL_ADMIN_OVERRIDE_EVENT]);
    expect(m.audit.log.mock.calls[1][0].metadata).toMatchObject({ action: 'update', grantees: [{ userId: TARGET, role: 'writer' }] });
  });
});

describe('INV-4 (#797): the admin disjunct is decided on the human only (recorded exception to #617)', () => {
  // The fork never sees the delegated service account on an ACL route (the platform relays as the human), and the
  // ceiling must not ask for one: `admin_cascade` is checked for the acting human, never intersected with a
  // service-account leg. If a later change adds a service leg, this pin goes red and the exception must be revisited.
  it('every PDP read the ceiling makes names the human (docmost subject); none names a service account', async () => {
    const m = make({ access: 'cascade' });
    await m.service.addPermission({ pageId: PAGE_ID, role: 'writer', userIds: [TARGET] } as AddPagePermissionDto, m.user);
    const subjects = m.authz.tryCheckBulk.mock.calls.map((c) => c[0]);
    expect(subjects.length).toBeGreaterThanOrEqual(3); // the gate, the inputs, the page check
    for (const s of subjects) expect(s).toEqual({ provider: 'docmost', externalId: ACTOR });
    const inputs = m.authz.tryCheckBulk.mock.calls.find((c) =>
      (c[1] as Array<{ permission: string }>).some((x) => x.permission === 'admin_cascade'),
    )!;
    expect(inputs[1]).toEqual([
      { permission: 'view', resourceType: 'space', resourceId: SPACE_ID },
      { permission: 'admin_cascade', resourceType: 'workspace', resourceId: WS_ID },
    ]);
  });
});

describe('INV-4 (#797): native mode (no PDP)', () => {
  it('the actor’s own rows decide; the owner/admin role is the admin disjunct (audited as an override); a member without a row is refused', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const own = make({ mode: 'native', access: 'edit' });
      await own.service.addPermission({ pageId: PAGE_ID, role: 'writer', userIds: [TARGET] } as AddPagePermissionDto, own.user);
      expect(own.auditEvents()).toEqual(['page.permission_added']);

      const owner = make({ mode: 'native', access: 'none', userRole: 'owner' });
      await owner.service.addPermission({ pageId: PAGE_ID, role: 'writer', userIds: [TARGET] } as AddPagePermissionDto, owner.user);
      expect(owner.auditEvents()).toEqual(['page.permission_added', ACL_ADMIN_OVERRIDE_EVENT]);

      const member = make({ mode: 'native', access: 'view', userRole: 'member' });
      await expect(
        member.service.addPermission({ pageId: PAGE_ID, role: 'writer', userIds: [TARGET] } as AddPagePermissionDto, member.user),
      ).rejects.toMatchObject({ status: 403, response: { code: 'grant_exceeds_actor' } });
      for (const m of [own, owner, member]) {
        expect(m.authz.tryCheckBulk).not.toHaveBeenCalled();
        expect(m.authz.settleProjection).not.toHaveBeenCalled();
      }
    } finally {
      warn.mockRestore();
    }
  });
});

describe('INV-6 (#797): restricted pages take per-user grants only', () => {
  const groupAdd = { pageId: PAGE_ID, role: 'reader', groupIds: [GROUP] };
  it.each<[Body, Record<string, unknown>]>([
    ['native', {}],
    ['relay', { expectedVersion: '*' }],
  ])('add naming a group → 400 group_grant_not_allowed_on_restricted_page (%s body), nothing written, unaudited', async (_b, extra) => {
    for (const mode of ['remote', 'native'] as const) {
      const m = make({ mode, access: 'cascade', userRole: 'owner' });
      const err = await m.controller.addPermission({ ...groupAdd, ...extra } as AddPagePermissionDto, m.user).catch((e) => e);
      expect(err).toMatchObject({ status: 400, response: { code: 'group_grant_not_allowed_on_restricted_page' } });
      expect(m.spy.tx).toEqual([]);
      expect(m.audit.log).not.toHaveBeenCalled();
      const mixed = await m.controller
        .addPermission({ ...groupAdd, userIds: [TARGET], ...extra } as AddPagePermissionDto, m.user)
        .catch((e) => e);
      expect(refusalCodeOf(mixed)).toBe('group_grant_not_allowed_on_restricted_page');
      expect(m.repo.insertPagePermissions).not.toHaveBeenCalled();
    }
  });

  it('its preview reports the same refusal', async () => {
    const m = make({ access: 'cascade' });
    await expect(m.service.preview({ ...groupAdd, action: 'add' } as RestrictionPreviewDto, m.user)).resolves.toMatchObject({
      outcome: 'refused',
      code: 'group_grant_not_allowed_on_restricted_page',
    });
  });

  it('A1 still wins for a group the actor is in (its self_grant stays audited)', async () => {
    const m = make({ access: 'cascade', actorGroups: [GROUP] });
    await expect(m.service.addPermission(groupAdd as AddPagePermissionDto, m.user)).rejects.toMatchObject({
      response: { code: 'self_grant' },
    });
    expect(m.auditEvents()).toEqual([ACL_WRITE_REFUSED_EVENT]);
  });

  const groupUpdate = (role: 'reader' | 'writer') => ({ pageId: PAGE_ID, role, groupId: GROUP });
  it('raising a grandfathered group grant (reader → writer) → 400, real and preview, even for a workspace admin', async () => {
    const m = make({ access: 'cascade', grants: [{ userId: null, groupId: GROUP, role: 'reader' }] });
    await expect(m.service.updatePermission(groupUpdate('writer') as UpdatePagePermissionDto, m.user)).rejects.toMatchObject({
      status: 400,
      response: { code: 'group_grant_not_allowed_on_restricted_page' },
    });
    expect(m.order).not.toContain('write');
    await expect(
      m.service.preview({ ...groupUpdate('writer'), action: 'update' } as RestrictionPreviewDto, m.user),
    ).resolves.toMatchObject({ outcome: 'refused', code: 'group_grant_not_allowed_on_restricted_page' });
  });

  it('lowering a grandfathered group grant (writer → reader), or re-setting its role, applies — even for an actor with no page access', async () => {
    const lower = make({ access: 'none', grants: [{ userId: null, groupId: GROUP, role: 'writer' }] });
    await expect(lower.service.updatePermission(groupUpdate('reader') as UpdatePagePermissionDto, lower.user)).resolves.toMatchObject({
      effect: { changed: [{ groupId: GROUP, fromRole: 'writer', toRole: 'reader' }] },
    });
    const same = make({ access: 'none', grants: [{ userId: null, groupId: GROUP, role: 'writer' }] });
    await expect(same.service.updatePermission(groupUpdate('writer') as UpdatePagePermissionDto, same.user)).resolves.toMatchObject({
      effect: { changed: [] },
    });
  });

  it('removing a grandfathered group grant applies', async () => {
    const m = make({ access: 'none', grants: [{ userId: null, groupId: GROUP, role: 'writer' }] });
    await expect(
      m.service.removePermission({ pageId: PAGE_ID, groupIds: [GROUP] }, m.user),
    ).resolves.toMatchObject({ version: expect.any(String) });
    expect(m.repo.deletePagePermissionsByGroupIds).toHaveBeenCalledWith(ACCESS_ID, [GROUP], expect.anything());
  });
});
