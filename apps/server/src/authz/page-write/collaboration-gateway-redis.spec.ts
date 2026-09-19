// The gateway pulls the Hocuspocus/RedisSync/ioredis graph (heavy, partly ESM). Stub the value-imports so
// we can construct the gateway and drive ONLY handleYjsEvent's routing guard (#344). None of the collab
// machinery actually runs here. This spec lives under authz/ (fork-owned) so it does not add an undocumented
// file to the upstream-owned collaboration/ tree.
jest.mock('@hocuspocus/server', () => ({
  Hocuspocus: jest.fn().mockImplementation(() => ({
    configuration: { extensions: [] as unknown[] },
  })),
}));

const handleEvent = jest.fn((..._a: unknown[]) => 'ROUTED');
jest.mock('../../collaboration/extensions/redis-sync', () => ({
  RedisSyncExtension: jest.fn().mockImplementation(() => ({
    onConfigure: jest.fn(),
    handleEvent: (...a: unknown[]) => handleEvent(...a),
  })),
}));
jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('msgpackr', () => ({ pack: jest.fn(), unpack: jest.fn() }));
// Provide BOTH `nanoid` and `customAlphabet`: the gateway imports `nanoid`, but its (unmocked) import
// graph reaches `common/helpers/nanoid.utils.ts`, which calls `customAlphabet(...)` at module TOP LEVEL.
// A mock missing `customAlphabet` throws "customAlphabet is not a function" at load. `customAlphabet`
// returns a generator function, so the mock returns a function that returns an id.
jest.mock('nanoid', () => ({
  nanoid: () => 'test',
  customAlphabet: () => () => 'test',
}));
jest.mock('../../common/helpers', () => ({
  createRetryStrategy: jest.fn(),
  parseRedisUrl: jest.fn(() => ({ host: 'h', port: 6379, password: '', db: 0 })),
}));

import { CollaborationGateway } from '../../collaboration/collaboration.gateway';

/**
 * #344 — the NARROWEST fail-fast for COLLAB_DISABLE_REDIS (single-node standalone).
 *
 * Custom collaboration events are registered ONLY on the RedisSync extension, so with Redis disabled
 * `handleYjsEvent` cannot route them. That is tolerable for best-effort events and for the #282 seams
 * (whose callers fail closed on `undefined` → 503), but NOT for `updatePageContent`: `PageService.update`
 * ignores its void result, so a REST/`/v1` content write would return a false 200 while persisting nothing.
 * The guard fails that one write loudly and leaves the supported standalone mode — and interactive editing,
 * which never uses this method — untouched.
 */
describe('CollaborationGateway.handleYjsEvent routing guard (#344)', () => {
  const makeGateway = (collabDisableRedis: boolean) => {
    const env = {
      getRedisUrl: () => 'redis://localhost:6379',
      isCollabDisableRedis: () => collabDisableRedis,
    };
    const handler = { getHandlers: jest.fn(() => ({})) };
    return new CollaborationGateway(
      {} as never, // authentication extension
      {} as never, // persistence extension
      {} as never, // logger extension
      env as never,
      handler as never,
    );
  };

  beforeEach(() => handleEvent.mockClear());

  describe('with Redis DISABLED (standalone)', () => {
    it('throws for updatePageContent (the false-200 write is failed loudly, not silently no-op)', () => {
      const gw = makeGateway(true);
      expect(() => gw.handleYjsEvent('updatePageContent', 'page.1', {} as never)).toThrow(
        /COLLAB_DISABLE_REDIS/,
      );
    });

    it('does NOT throw for a best-effort event — standalone mode is preserved', () => {
      const gw = makeGateway(true);
      // forceDisconnect returns undefined (redisSync is null) and must not become a hard error.
      expect(gw.handleYjsEvent('forceDisconnect', 'page.1', { userId: 'u1' } as never)).toBeUndefined();
    });
  });

  describe('with Redis ENABLED (normal deployment)', () => {
    it('routes updatePageContent through RedisSync, never throwing', () => {
      const gw = makeGateway(false);
      expect(gw.handleYjsEvent('updatePageContent', 'page.1', {} as never)).toBe('ROUTED');
      expect(handleEvent).toHaveBeenCalledWith('updatePageContent', 'page.1', {});
    });
  });

  // #345 defect 3 — pin the durability config. Hocuspocus only flushes a PENDING debounced store on the last
  // client disconnect when `unloadImmediately` is true (its onClose calls `executeNow`); with `false` it waits
  // out the 10s/45s timer, so a restart in that window loses unsaved edits. This locks the value so a future
  // edit can't silently flip it back to the (lossy) upstream override. The flush-on-disconnect behavior itself
  // is upstream Hocuspocus and is covered there.
  describe('persistence durability config (#345)', () => {
    it('constructs Hocuspocus with unloadImmediately:true', () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Hocuspocus } = require('@hocuspocus/server');
      (Hocuspocus as jest.Mock).mockClear();
      makeGateway(true);
      const calls = (Hocuspocus as jest.Mock).mock.calls;
      const cfg = calls[calls.length - 1][0];
      expect(cfg).toMatchObject({ unloadImmediately: true });
    });
  });
});
