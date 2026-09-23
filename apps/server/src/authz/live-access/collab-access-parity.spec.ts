import { NotFoundException, UnauthorizedException } from '@nestjs/common';

// collaboration.util pulls in tiptap/@docmost/editor-ext/yjs, which jest cannot load; the extension only needs
// getPageId from it.
jest.mock('../../collaboration/collaboration.util', () => ({
  getPageId: (name: string) => name.split('.')[1],
}));

import { AuthenticationExtension } from '../../collaboration/extensions/authentication.extension';
import { PdpSpaceMemberRepo } from '../pdp-space-member.repo';
import { PdpPagePermissionRepo } from '../pdp-page-permission.repo';
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
 * (no action; the revalidator caps consecutive unknowns). That mapping is asserted explicitly below.
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
    new PdpPagePermissionRepo({} as any, {} as any, {} as any, authz),
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
  });
}

const cases: Case[] = [];
const roles: Array<[string, Grants]> = [
  ['admin', { administer: true, edit: true, view: true }],
  ['writer', { edit: true, view: true }],
  ['reader', { view: true }],
  ['no role', {}],
];
for (const [role, space] of roles) {
  for (const locked of [false, true]) {
    for (const pageView of [false, true]) {
      for (const pageEdit of [false, true]) {
        if (pageEdit && !pageView) continue; // edit implies view in the schema
        cases.push({
          name: `${role}, locked=${locked}, pageView=${pageView}, pageEdit=${pageEdit}`,
          grants: { ...space, locked, pageView, pageEdit },
        });
      }
    }
  }
}
cases.push(
  {
    name: 'writer on a TRASHED page',
    page: { ...livePage, deletedAt: new Date() },
    grants: { edit: true, view: true, pageView: true, pageEdit: true },
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

  it('a PDP failure is DENY at connect (fail closed) but UNKNOWN on revalidation (no mass eviction)', async () => {
    const c: Case = {
      name: 'pdp down',
      grants: { edit: true, view: true, pageView: true, pageEdit: true },
      pdpFails: true,
    };
    expect(await connectDecision(c)).toBe('deny');
    expect(revalidateDecision(c)).toBe('unknown');
  });
});
