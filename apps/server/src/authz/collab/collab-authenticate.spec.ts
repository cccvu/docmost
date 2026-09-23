// The extension's `getPageId` comes from collaboration.util, whose module graph pulls tiptap/yjs (lib0 ESM) that
// jest cannot parse. Stub it (as collab-flush-handler.spec.ts does); the `@hocuspocus/server` import is type-only
// and is elided by ts-jest.
jest.mock('../../collaboration/collaboration.util', () => ({
  getPageId: (documentName: string) => documentName.split('.')[1],
}));

import { UnauthorizedException } from '@nestjs/common';
import { AuthenticationExtension } from '../../collaboration/extensions/authentication.extension';
import { PdpPagePermissionRepo } from '../pdp-page-permission.repo';
import { spyKysely } from '../../service-bridge/kysely-spy.testkit';

/**
 * CCC authorization integration test — NOT upstream Docmost code.
 *
 * #524 on the collab websocket. The Hocuspocus connect check calls `canUserEditPage` itself and, like
 * PageAccessService, falls back to the SPACE role when the answer is "unrestricted". For a trashed page in a
 * restricted section the PDP answered exactly that (its #parent edge is reaped), so any space member could open
 * the page's document. This drives the REAL extension over the REAL PDP repo (PDP and rows stubbed).
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
      { verifyJwt: async () => ({ sub: 'u1', workspaceId: 'w1' }) } as any,
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
