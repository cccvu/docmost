import { InternalServerErrorException, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { authzUnavailable } from '../authz-unavailable';
import { spaceIdsForConnect } from './ws-space-rooms';

/**
 * #716: the socket.io connect's space rooms. `getUserSpaceIds` now answers a PDP outage with a 503; the connect alone
 * degrades it to no space rooms (a throw would disconnect the socket for the session) and logs it. Every other error
 * still reaches the gateway's catch, which refuses the connection.
 */
const USER = '0198c2a1-0000-7000-8000-000000000001';
const repo = (impl: () => Promise<string[]>) =>
  ({ getUserSpaceIds: jest.fn(impl) }) as unknown as SpaceMemberRepo & { getUserSpaceIds: jest.Mock };

describe('spaceIdsForConnect (#716)', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('healthy: the repo answer, unchanged, and no log', async () => {
    const r = repo(async () => ['s1', 's2']);
    await expect(spaceIdsForConnect(r, USER)).resolves.toEqual(['s1', 's2']);
    expect(r.getUserSpaceIds).toHaveBeenCalledWith(USER);
    expect(warn).not.toHaveBeenCalled();
  });

  it('healthy and empty (member of no space): [] and no log', async () => {
    await expect(spaceIdsForConnect(repo(async () => []), USER)).resolves.toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('the PDP could not answer (authzUnavailable): no space rooms, and a WS_SPACE_ROOMS_DEGRADED line', async () => {
    await expect(
      spaceIdsForConnect(
        repo(async () => {
          throw authzUnavailable();
        }),
        USER,
      ),
    ).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(new RegExp(`^WS_SPACE_ROOMS_DEGRADED user=${USER}\\b`));
  });

  it('any ServiceUnavailableException degrades the same way', async () => {
    await expect(
      spaceIdsForConnect(
        repo(async () => {
          throw new ServiceUnavailableException('engine busy');
        }),
        USER,
      ),
    ).resolves.toEqual([]);
  });

  it.each([
    ['a plain Error', new Error('db down')],
    ['a 500', new InternalServerErrorException()],
    ['a 404', new NotFoundException()],
  ])('%s is rethrown (the gateway refuses the connection), never degraded', async (_label, err) => {
    await expect(
      spaceIdsForConnect(
        repo(async () => {
          throw err;
        }),
        USER,
      ),
    ).rejects.toBe(err);
    expect(warn).not.toHaveBeenCalled();
  });
});
