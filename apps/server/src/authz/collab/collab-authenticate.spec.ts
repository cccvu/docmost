// The extension's `getPageId` comes from collaboration.util, whose module graph pulls tiptap/yjs (lib0 ESM) that
// jest cannot parse. Stub it (as collab-flush-handler.spec.ts does); the `@hocuspocus/server` import is type-only
// and is elided by ts-jest.
jest.mock('../../collaboration/collaboration.util', () => ({
  getPageId: (documentName: string) => documentName.split('.')[1],
}));

import { UnauthorizedException } from '@nestjs/common';
import { AuthenticationExtension } from '../../collaboration/extensions/authentication.extension';
import { COLLAB_INVALID_TOKEN_REASON } from '../collab-ingress/auth-refusal';
import { CollabSocketBounds } from '../collab-ingress/socket-bounds';
import { PdpPagePermissionRepo } from '../pdp-page-permission.repo';
import { PdpSpaceMemberRepo } from '../pdp-space-member.repo';
import { spyKysely } from '../../service-bridge/kysely-spy.testkit';

/** #537: the connect re-checks the token's session; these suites hold it live. */
const liveSessions = {
  findActiveById: async (id: string) => ({ id, userId: 'u1', workspaceId: 'w1' }),
} as any;

/**
 * CCC authorization integration test — NOT upstream Docmost code.
 *
 * #524 on the collab websocket. The Hocuspocus connect check calls `canUserEditPage` itself and, like
 * PageAccessService, falls back to the SPACE role when the answer is "unrestricted". For a page the PDP has not
 * placed (no view, not locked) in a restricted section that fallback would let any space member open the page's
 * document. Since ADR 0027 Release B (#493) trashing KEEPS a page's #space/#parent edges, so in production such a
 * page is new or re-parented and not projected yet; the trashed fixture below is the defensive case. This drives
 * the REAL extension over the REAL PDP repo (PDP and rows stubbed).
 */
describe('#524 — the collab connect refuses a page the PDP has not placed in a restricted section', () => {
  const row = (
    id: string,
    parent: string | null,
    depth: number,
    restricted = false,
  ) => ({
    id,
    parent_page_id: parent,
    depth,
    restricted,
  });
  const unplaced = {
    tryCheckBulk: async (_s: unknown, checks: unknown[]) =>
      checks.map(() => false),
  };
  const extension = (lineage: unknown[]) =>
    new AuthenticationExtension(
      { verifyJwt: async () => ({ sub: 'u1', workspaceId: 'w1', sessionId: 'sid1' }) } as any,
      {
        findById: async () => ({
          id: 'u1',
          deactivatedAt: null,
          deletedAt: null,
        }),
      } as any,
      {
        findById: async () => ({
          id: 'c',
          spaceId: 's1',
          deletedAt: new Date(),
        }),
      } as any,
      {
        getUserSpaceRoles: async () => [{ userId: 'u1', role: 'writer' }],
      } as any,
      new PdpPagePermissionRepo(
        spyKysely(() => lineage).db,
        {} as any,
        {} as any,
        unplaced as any,
      ),
      liveSessions,
      new CollabSocketBounds(),
    );
  const payload = () =>
    ({
      documentName: 'page.c',
      token: 't',
      connectionConfig: { readOnly: false },
    }) as any;

  it('refuses a space writer on a trashed page that inherits a restriction', async () => {
    const ext = extension([row('c', 'r', 0), row('r', null, 1, true)]);
    await expect(ext.onAuthenticate(payload())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('control: a trashed page with an unrestricted lineage still connects, read-only (upstream behaviour)', async () => {
    const ext = extension([row('c', 'p', 0), row('p', null, 1)]);
    const data = payload();
    await expect(ext.onAuthenticate(data)).resolves.toEqual({
      user: expect.objectContaining({ id: 'u1' }),
    });
    expect(data.connectionConfig.readOnly).toBe(true);
  });
});

/**
 * #542 on the collab websocket: the connect takes the space role from `PdpSpaceMemberRepo.getUserSpaceRoles`, which
 * now needs space#view (and admin needs edit too). Drives the REAL extension over BOTH real PDP repos.
 */
describe('#542 — the collab connect takes the strict PDP space role', () => {
  const PAGE = 'p1';
  const SPACE = 's1';
  /** A PDP answering space and page permissions from `grants`; page `locked` is false (an unrestricted page). */
  const pdp = (grants: Record<string, boolean>) => {
    const answer = (checks: Array<{ permission: string; resourceType: string }>) =>
      checks.map((c) => grants[`${c.resourceType}:${c.permission}`] === true);
    return { checkBulk: async (_s: unknown, c: any[]) => answer(c), tryCheckBulk: async (_s: unknown, c: any[]) => answer(c) };
  };
  // The page is a live root with no restriction in the fork's rows (read only when the PDP neither shows nor locks it).
  const openLineage = () => spyKysely((q) => [{ id: q.parameters[0], parent_page_id: null, depth: 0, restricted: false }]).db;
  const extension = (grants: Record<string, boolean>) => {
    const authz = pdp(grants) as any;
    return new AuthenticationExtension(
      { verifyJwt: async () => ({ sub: 'u1', workspaceId: 'w1', sessionId: 'sid1' }) } as any,
      { findById: async () => ({ id: 'u1', deactivatedAt: null, deletedAt: null }) } as any,
      { findById: async () => ({ id: PAGE, spaceId: SPACE, deletedAt: null }) } as any,
      new PdpSpaceMemberRepo({} as any, {} as any, {} as any, {} as any, authz),
      new PdpPagePermissionRepo(openLineage(), {} as any, {} as any, authz),
      liveSessions,
      new CollabSocketBounds(),
    );
  };
  const payload = () => ({ documentName: `page.${PAGE}`, token: 't', connectionConfig: { readOnly: false } }) as any;

  it('refuses a space admin without space view (manage_members only) on an unrestricted page', async () => {
    await expect(extension({ 'space:administer': true }).onAuthenticate(payload())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('refuses an edit-only binding without space view', async () => {
    await expect(
      extension({ 'space:administer': true, 'space:edit': true }).onAuthenticate(payload()),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('connects administer + view without edit READ-ONLY on an unrestricted page (reader, never admin)', async () => {
    const data = payload();
    await extension({ 'space:administer': true, 'space:view': true, 'page:view': true }).onAuthenticate(data);
    expect(data.connectionConfig.readOnly).toBe(true);
  });

  it('control: administer + edit + view connects read-write (the tests are not vacuous)', async () => {
    const data = payload();
    await extension({
      'space:administer': true,
      'space:edit': true,
      'space:view': true,
      'page:view': true,
      'page:edit': true,
    }).onAuthenticate(data);
    expect(data.connectionConfig.readOnly).toBe(false);
  });
});

/**
 * #537 — the collab token names the access token's session, and the connect re-checks that session row with the
 * SAME rule as /api and the notifications socket (`isWsConnectionLive`). Before this, a signed-out or revoked
 * session kept opening collab documents for the collab token's 24h life.
 */
describe('#537 — the collab connect refuses a token whose session is not live', () => {
  const SID = 'sid-537';
  const liveRow = { id: SID, userId: 'u1', workspaceId: 'w1' };
  const build = (opts: {
    claims?: Record<string, unknown>;
    session?: (id: string) => Promise<unknown>;
    page?: unknown;
  }) => {
    const findActiveById = jest.fn(opts.session ?? (async () => liveRow));
    const pageFindById = jest.fn(async () =>
      'page' in opts ? opts.page : { id: 'p1', spaceId: 's1', deletedAt: null },
    );
    const ext = new AuthenticationExtension(
      {
        verifyJwt: async () => ({ sub: 'u1', workspaceId: 'w1', type: 'collab', sessionId: SID, ...opts.claims }),
      } as any,
      { findById: async () => ({ id: 'u1', deactivatedAt: null, deletedAt: null }) } as any,
      { findById: pageFindById } as any,
      { getUserSpaceRoles: async () => [{ userId: 'u1', role: 'writer' }] } as any,
      { canUserEditPage: async () => ({ hasAnyRestriction: false, canAccess: true, canEdit: true }) } as any,
      { findActiveById } as any,
      new CollabSocketBounds(),
    );
    return { ext, findActiveById, pageFindById };
  };
  const payload = () => ({ documentName: 'page.p1', token: 't', connectionConfig: { readOnly: false } }) as any;

  it("control: a live session connects read-write, and the row read is the token's sessionId", async () => {
    const { ext, findActiveById } = build({});
    const data = payload();
    await expect(ext.onAuthenticate(data)).resolves.toEqual({ user: expect.objectContaining({ id: 'u1' }) });
    expect(data.connectionConfig.readOnly).toBe(false);
    expect(findActiveById).toHaveBeenCalledWith(SID);
  });

  it('refuses a token with no sessionId (a pre-#537 token), as an invalid token, before any read (#810)', async () => {
    const { ext, findActiveById } = build({ claims: { sessionId: undefined } });
    await expect(ext.onAuthenticate(payload())).rejects.toEqual({ reason: COLLAB_INVALID_TOKEN_REASON });
    expect(findActiveById).not.toHaveBeenCalled();
  });

  it('refuses a revoked or expired session (no active row)', async () => {
    const { ext } = build({ session: async () => undefined });
    await expect(ext.onAuthenticate(payload())).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("refuses another user's session", async () => {
    const { ext } = build({ session: async () => ({ ...liveRow, userId: 'u2' }) });
    await expect(ext.onAuthenticate(payload())).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("refuses another workspace's session", async () => {
    const { ext } = build({ session: async () => ({ ...liveRow, workspaceId: 'w2' }) });
    await expect(ext.onAuthenticate(payload())).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('a failed session read refuses the connection (throws), never allows', async () => {
    const boom = new Error('db down');
    const { ext } = build({
      session: async () => {
        throw boom;
      },
    });
    await expect(ext.onAuthenticate(payload())).rejects.toBe(boom);
  });

  it('a dead session on a missing page is Unauthorized, not NotFound, and the page is never read', async () => {
    const { ext, pageFindById } = build({ session: async () => undefined, page: undefined });
    await expect(ext.onAuthenticate(payload())).rejects.toBeInstanceOf(UnauthorizedException);
    expect(pageFindById).not.toHaveBeenCalled();
  });
});
