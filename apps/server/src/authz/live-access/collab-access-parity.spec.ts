import { NotFoundException, UnauthorizedException } from '@nestjs/common';

// collaboration.util pulls in tiptap/@docmost/editor-ext/yjs, which jest cannot load; the extension only needs
// getPageId from it.
jest.mock('../../collaboration/collaboration.util', () => ({
  getPageId: (name: string) => name.split('.')[1],
}));

import { AuthenticationExtension } from '../../collaboration/extensions/authentication.extension';
import { PdpSpaceMemberRepo } from '../pdp-space-member.repo';
import { PdpPagePermissionRepo } from '../pdp-page-permission.repo';
import { spyKysely } from '../../service-bridge/kysely-spy.testkit';
import { CollabAccess, decideCollabAccess } from './collab-access.decision';

/**
 * CCC authorization fitness test (#501).
 *
 * `decideCollabAccess` (the live-connection revalidator's decision) deliberately RE-IMPLEMENTS the upstream
 * connect-time decision in `AuthenticationExtension.onAuthenticate`. If the two ever disagree, the revalidator
 * either leaves open a connection the connect path would refuse (fail OPEN), or closes one the connect path
 * lets straight back in (a close → reconnect → close loop). This drives the SAME facts through BOTH — the real
 * extension over the real PDP-backed repos, and the pure decision — and asserts they agree.
 *
 * The one deliberate difference is a PDP failure: connect fails closed (deny), revalidation answers `unknown`
 * (no action; the revalidator caps consecutive unknowns). That mapping is asserted explicitly below, and so is the
 * same mapping for a failed #524 lineage read.
 *
 * #524: each case also fixes the page's lineage in the fork's own rows (`open` = a root with no restriction,
 * `restricted` = a restriction on it). The connect path reads it through the real repo; the decision is handed
 * what the revalidator would read (`lineageRestricted`).
 */

const USER = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
const PAGE = '33333333-3333-4333-8333-333333333333';
const SPACE = '44444444-4444-4444-8444-444444444444';

type Grants = Partial<
  Record<
    'administer' | 'edit' | 'view' | 'pageView' | 'pageEdit' | 'locked',
    boolean
  >
>;

interface Case {
  name: string;
  user?: Record<string, unknown> | null;
  page?: Record<string, unknown> | null;
  grants: Grants;
  pdpFails?: boolean;
  lineage?: 'open' | 'restricted' | 'error';
}

/** The fork DB for the repo's #524 lineage walk: a one-row walk that ends at a root. */
function dbFor(c: Case) {
  return spyKysely((q) => {
    if (c.lineage === 'error') throw new Error('db down');
    return [
      {
        id: q.parameters[0],
        parent_page_id: null,
        depth: 0,
        restricted: c.lineage === 'restricted',
      },
    ];
  }).db;
}

/** A PDP stub for the repos: answers space administer/edit/view and page view/edit/locked from `grants`. */
function authzFor(c: Case) {
  const answer = (items: { permission: string; resourceType: string }[]) =>
    items.map((i) => {
      const g = c.grants;
      if (i.resourceType === 'space')
        return !!g[i.permission as 'administer' | 'edit' | 'view'];
      if (i.permission === 'view') return !!g.pageView;
      if (i.permission === 'edit') return !!g.pageEdit;
      return !!g.locked;
    });
  return {
    checkBulk: async (
      _s: unknown,
      items: { permission: string; resourceType: string }[],
    ) => (c.pdpFails ? items.map(() => false) : answer(items)), // the real client's fail-closed all-false
    tryCheckBulk: async (
      _s: unknown,
      items: { permission: string; resourceType: string }[],
    ) => (c.pdpFails ? null : answer(items)),
  };
}

const liveUser = {
  id: USER,
  workspaceId: WS,
  deactivatedAt: null,
  deletedAt: null,
};
const livePage = { id: PAGE, spaceId: SPACE, deletedAt: null };

async function connectDecision(c: Case): Promise<CollabAccess> {
  const authz = authzFor(c) as any;
  const ext = new AuthenticationExtension(
    { verifyJwt: async () => ({ sub: USER, workspaceId: WS }) } as any,
    { findById: async () => (c.user === undefined ? liveUser : c.user) } as any,
    { findById: async () => (c.page === undefined ? livePage : c.page) } as any,
    new PdpSpaceMemberRepo({} as any, {} as any, {} as any, {} as any, authz),
    new PdpPagePermissionRepo(dbFor(c), {} as any, {} as any, authz),
  );
  const data = {
    documentName: `page.${PAGE}`,
    token: 't',
    connectionConfig: { readOnly: false },
  } as any;
  try {
    await ext.onAuthenticate(data);
  } catch (e) {
    if (e instanceof UnauthorizedException || e instanceof NotFoundException)
      return 'deny';
    throw e;
  }
  return data.connectionConfig.readOnly ? 'read' : 'write';
}

function revalidateDecision(c: Case): CollabAccess {
  const g = c.grants;
  return decideCollabAccess({
    user: c.user === undefined ? liveUser : c.user,
    page: c.page === undefined ? livePage : c.page,
    space: c.pdpFails
      ? null
      : { administer: !!g.administer, edit: !!g.edit, view: !!g.view },
    pagePerms: c.pdpFails
      ? null
      : { view: !!g.pageView, edit: !!g.pageEdit, locked: !!g.locked },
    lineageRestricted:
      c.lineage === 'error' ? null : c.lineage === 'restricted',
  });
}

const cases: Case[] = [];
const roles: Array<[string, Grants]> = [
  ['admin', { administer: true, edit: true, view: true }],
  ['writer', { edit: true, view: true }],
  ['reader', { view: true }],
  ['no role', {}],
  // #542: bindings without space view (or without edit) must get exactly what the PDP gives — no native role
  // without view, and reader (never admin) for administer + view without edit.
  ['administer only (manage_members, no view)', { administer: true }],
  ['administer + view, no edit', { administer: true, view: true }],
  ['edit only (no view)', { edit: true }],
  ['administer + edit, no view', { administer: true, edit: true }],
];
for (const [role, space] of roles) {
  for (const locked of [false, true]) {
    for (const pageView of [false, true]) {
      for (const pageEdit of [false, true]) {
        // Edit implies view in the schema since #542: `role_binding.can_edit` requires `grants_view` too, so no
        // binding (space or page scope) yields page#edit without page#view.
        if (pageEdit && !pageView) continue;
        for (const lineage of ['open', 'restricted'] as const) {
          cases.push({
            name: `${role}, locked=${locked}, pageView=${pageView}, pageEdit=${pageEdit}, lineage=${lineage}`,
            grants: { ...space, locked, pageView, pageEdit },
            lineage,
          });
        }
      }
    }
  }
}
cases.push(
  // #542: named negatives on an unrestricted, placed page (also covered by the matrix above).
  {
    name: '#542 administer without view on an unrestricted page → deny',
    grants: { administer: true, pageView: false, pageEdit: false },
    lineage: 'open',
  },
  {
    name: '#542 administer + view without edit on an unrestricted page → read-only',
    grants: { administer: true, view: true, pageView: true },
    lineage: 'open',
  },
  {
    name: 'writer on a TRASHED page',
    page: { ...livePage, deletedAt: new Date() },
    grants: { edit: true, view: true, pageView: true, pageEdit: true },
  },
  // #524: "no view, not locked" — a page the PDP has not placed. Since ADR 0027 Release B (#493) trashing KEEPS the
  // #space/#parent edges, so in production this is a new or re-parented page not projected yet (or a subject without
  // space view); the trashed variant stays as the defensive case.
  {
    name: 'writer on a TRASHED page the PDP no longer places, restricted lineage',
    page: { ...livePage, deletedAt: new Date() },
    grants: { edit: true, view: true },
    lineage: 'restricted',
  },
  {
    name: 'writer on a TRASHED page the PDP no longer places, open lineage',
    page: { ...livePage, deletedAt: new Date() },
    grants: { edit: true, view: true },
    lineage: 'open',
  },
  {
    name: 'missing user',
    user: null,
    grants: { edit: true, view: true, pageView: true, pageEdit: true },
  },
  {
    name: 'DEACTIVATED user',
    user: { ...liveUser, deactivatedAt: new Date() },
    grants: { edit: true, view: true, pageView: true, pageEdit: true },
  },
  {
    name: 'DELETED user',
    user: { ...liveUser, deletedAt: new Date() },
    grants: { edit: true, view: true, pageView: true, pageEdit: true },
  },
  {
    name: 'missing page',
    page: null,
    grants: { edit: true, view: true, pageView: true, pageEdit: true },
  },
);

describe('collab access parity: decideCollabAccess ⇔ AuthenticationExtension.onAuthenticate (#501)', () => {
  it.each(cases)('agrees on: $name', async (c) => {
    expect(revalidateDecision(c)).toBe(await connectDecision(c));
  });

  it.each([
    ['administer only (no view)', { administer: true }, 'deny'],
    ['administer + edit (no view)', { administer: true, edit: true }, 'deny'],
    ['edit only (no view)', { edit: true }, 'deny'],
    ['administer + view (no edit)', { administer: true, view: true, pageView: true }, 'read'],
    ['view + edit, no administer', { edit: true, view: true, pageView: true, pageEdit: true }, 'write'],
    ['administer + edit + view', { administer: true, edit: true, view: true, pageView: true, pageEdit: true }, 'write'],
  ] as Array<[string, Grants, CollabAccess]>)(
    '#542: on an unrestricted page, %s → %s on BOTH paths (the role needs space view; admin needs edit too)',
    async (_n, grants, expected) => {
      const c: Case = { name: _n, grants, lineage: 'open' };
      expect(await connectDecision(c)).toBe(expected);
      expect(revalidateDecision(c)).toBe(expected);
    },
  );

  it('a PDP failure is DENY at connect (fail closed) but UNKNOWN on revalidation (no mass eviction)', async () => {
    const c: Case = {
      name: 'pdp down',
      grants: { edit: true, view: true, pageView: true, pageEdit: true },
      pdpFails: true,
    };
    expect(await connectDecision(c)).toBe('deny');
    expect(revalidateDecision(c)).toBe('unknown');
  });

  it('#524: a failed lineage read on an unplaced page is DENY at connect but UNKNOWN on revalidation', async () => {
    const c: Case = {
      name: 'lineage read fails',
      grants: { edit: true, view: true },
      lineage: 'error',
    };
    expect(await connectDecision(c)).toBe('deny');
    expect(revalidateDecision(c)).toBe('unknown');
  });

  it('#524: a failed lineage read is never consulted for a page the PDP places', async () => {
    const c: Case = {
      name: 'placed, lineage read would fail',
      grants: { edit: true, view: true, pageView: true, pageEdit: true },
      lineage: 'error',
    };
    expect(await connectDecision(c)).toBe('write');
    expect(revalidateDecision(c)).toBe('write');
  });

  it('non-vacuity: the lineage decides the unplaced cases (both paths flip together)', async () => {
    const base: Case = {
      name: 'unplaced writer',
      grants: { edit: true, view: true },
    };
    const open = { ...base, lineage: 'open' as const };
    const restricted = { ...base, lineage: 'restricted' as const };
    expect(await connectDecision(open)).toBe('write');
    expect(revalidateDecision(open)).toBe('write');
    expect(await connectDecision(restricted)).toBe('deny');
    expect(revalidateDecision(restricted)).toBe('deny');
  });
});
