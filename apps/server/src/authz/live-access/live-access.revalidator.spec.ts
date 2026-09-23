import * as fs from 'fs';
import * as path from 'path';

// The revalidator only uses the two gateways as constructor TYPES, but Nest emits their runtime require for DI
// metadata, which would pull the collab (lib0 ESM) and socket.io stacks into jest. Stub them; tests inject fakes.
jest.mock('../../collaboration/collaboration.gateway', () => ({
  CollaborationGateway: class {},
}));
jest.mock('../../ws/ws.gateway', () => ({ WsGateway: class {} }));

import { Logger } from '@nestjs/common';
import {
  LiveAccessRevalidator,
  UNKNOWN_CAP,
  UNKNOWN_GRACE_MS,
} from './live-access.revalidator';

/**
 * CCC authorization integration test (#501).
 *
 * The live-connection revalidator narrows every live connection that lost access, and ONLY narrows:
 *   - collab: `deny`, and `read` on a writable connection, close it; `write`/`read`-on-read-only are no-ops;
 *   - socket.io: a space room whose `view` is now false is left; a missing/disabled user is disconnected;
 *   - a PDP/DB failure is `unknown` → no action, until UNKNOWN_CAP consecutive unknowns spanning
 *     UNKNOWN_GRACE_MS, then it narrows and logs LIVE_ACCESS_REVALIDATE_FAILED;
 *   - it never sets `readOnly = false` and never joins a room.
 */

const U1 = 'u1';
const WS = 'ws1';
const S1 = 's1';

type Conn = {
  readOnly: boolean;
  context: { user: { id: string; workspaceId: string } };
  close: jest.Mock;
};
const conn = (readOnly = false, userId = U1): Conn => ({
  readOnly,
  context: { user: { id: userId, workspaceId: WS } },
  close: jest.fn(),
});
const doc = (pageId: string, conns: Conn[]) => ({
  name: `page.${pageId}`,
  getConnections: () => conns,
});

type Sock = {
  data: { userId?: string; workspaceId?: string };
  rooms: Set<string>;
  leave: jest.Mock;
  disconnect: jest.Mock;
};
const sock = (userId: string, rooms: string[]): Sock => ({
  data: { userId, workspaceId: WS },
  rooms: new Set([`user-${userId}`, `workspace-${WS}`, ...rooms]),
  leave: jest.fn(),
  disconnect: jest.fn(),
});

/** A PDP answering per (resourceType:resourceId:permission). A key missing from `grants` is false. */
function pdp(grants: Record<string, boolean>, opts: { fail?: boolean } = {}) {
  return {
    tryCheckBulk: jest.fn(
      async (
        _s: unknown,
        items: {
          permission: string;
          resourceType: string;
          resourceId: string;
        }[],
      ) =>
        opts.fail
          ? null
          : items.map(
              (i) =>
                grants[`${i.resourceType}:${i.resourceId}:${i.permission}`] ??
                false,
            ),
    ),
  };
}

function build(opts: {
  docs?: ReturnType<typeof doc>[];
  sockets?: Sock[];
  grants?: Record<string, boolean>;
  pdpFail?: boolean;
  user?: Record<string, unknown> | null | 'throw';
  pages?: Record<string, Record<string, unknown> | null>;
}) {
  const collab = { getResidentDocuments: () => (opts.docs ?? []).values() };
  const ws = {
    server: {
      of: () => ({
        sockets: new Map((opts.sockets ?? []).map((s, i) => [String(i), s])),
      }),
    },
  };
  const userRepo = {
    findById: jest.fn(async () => {
      if (opts.user === 'throw') throw new Error('db down');
      return opts.user === undefined
        ? { id: U1, deactivatedAt: null, deletedAt: null }
        : opts.user;
    }),
  };
  const pageRepo = {
    findById: jest.fn(async (id: string) =>
      opts.pages && id in opts.pages
        ? opts.pages[id]
        : { id, spaceId: S1, deletedAt: null },
    ),
  };
  const authz = pdp(opts.grants ?? {}, { fail: opts.pdpFail });
  const svc = new LiveAccessRevalidator(
    collab as any,
    ws as any,
    userRepo as any,
    pageRepo as any,
    authz as any,
    'remote',
  );
  return { svc, authz, userRepo, pageRepo };
}

/** A controllable clock: the unknown cap is time-bounded. */
let clock = 1_000_000;
beforeEach(() => {
  clock = 1_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
});
afterEach(() => jest.restoreAllMocks());

const writer = (pageId: string) => ({
  [`space:${S1}:edit`]: true,
  [`space:${S1}:view`]: true,
  [`page:${pageId}:view`]: true,
  [`page:${pageId}:edit`]: true,
});

describe('LiveAccessRevalidator — collab plane', () => {
  it('leaves a still-authorized writer alone', async () => {
    const c = conn(false);
    const { svc } = build({ docs: [doc('p1', [c])], grants: writer('p1') });
    const s = await svc.request('signal');
    expect(c.close).not.toHaveBeenCalled();
    expect(s).toMatchObject({ checked: 1, closed: 0 });
  });

  it('closes a connection whose user lost space membership (deny)', async () => {
    const c = conn(false);
    const { svc } = build({ docs: [doc('p1', [c])], grants: {} });
    const s = await svc.request('signal');
    expect(c.close).toHaveBeenCalledTimes(1);
    expect(s.closed).toBe(1);
  });

  it('closes a WRITABLE connection whose user was demoted to reader (it reconnects read-only)', async () => {
    const c = conn(false);
    const { svc } = build({
      docs: [doc('p1', [c])],
      grants: { [`space:${S1}:view`]: true, [`page:p1:view`]: true },
    });
    await svc.request('signal');
    expect(c.close).toHaveBeenCalledTimes(1);
  });

  it('leaves an already read-only connection alone when the decision is read', async () => {
    const c = conn(true);
    const { svc } = build({
      docs: [doc('p1', [c])],
      grants: { [`space:${S1}:view`]: true, [`page:p1:view`]: true },
    });
    await svc.request('signal');
    expect(c.close).not.toHaveBeenCalled();
  });

  it('closes a connection on a page that was restricted away from the user (locked, no view)', async () => {
    const c = conn(false);
    const { svc } = build({
      docs: [doc('p1', [c])],
      grants: {
        [`space:${S1}:edit`]: true,
        [`space:${S1}:view`]: true,
        [`page:p1:locked`]: true,
      },
    });
    await svc.request('signal');
    expect(c.close).toHaveBeenCalledTimes(1);
  });

  it('closes a connection whose user was disabled or deleted, and one whose page is gone', async () => {
    const a = conn(false);
    const disabled = build({
      docs: [doc('p1', [a])],
      grants: writer('p1'),
      user: { id: U1, deactivatedAt: new Date() },
    });
    await disabled.svc.request('signal');
    expect(a.close).toHaveBeenCalled();

    const b = conn(false);
    const gone = build({
      docs: [doc('p1', [b])],
      grants: writer('p1'),
      pages: { p1: null },
    });
    await gone.svc.request('signal');
    expect(b.close).toHaveBeenCalled();
  });

  it('does nothing on a PDP failure (unknown), then narrows after UNKNOWN_CAP passes spanning UNKNOWN_GRACE_MS, and alarms', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const c = conn(false);
    const { svc } = build({ docs: [doc('p1', [c])], pdpFail: true });
    for (let i = 1; i < UNKNOWN_CAP; i++) {
      const s = await svc.request('sweep');
      expect(s.unknown).toBe(1);
      expect(c.close).not.toHaveBeenCalled();
      clock += UNKNOWN_GRACE_MS / 2;
    }
    const s = await svc.request('sweep');
    expect(c.close).toHaveBeenCalledTimes(1);
    expect(s.unknownClosed).toBe(1);
    // The I/O failure path is what the LIVE_ACCESS_REVALIDATE_FAILED alarm is for (a pass never throws on it).
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('LIVE_ACCESS_REVALIDATE_FAILED'),
    );
  });

  it('a burst of fast-path passes during a PDP blip never narrows before UNKNOWN_GRACE_MS (#501 review)', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const c = conn(false);
    const room = sock(U1, ['space-s1']);
    const { svc } = build({
      docs: [doc('p1', [c])],
      sockets: [room],
      pdpFail: true,
    });
    for (let i = 0; i < UNKNOWN_CAP * 4; i++) {
      await svc.request('signal'); // passes ~250 ms to 2 s apart, far more than UNKNOWN_CAP of them
      clock += 2000;
    }
    expect(c.close).not.toHaveBeenCalled();
    expect(room.leave).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled(); // and no alarm for a blip
  });

  it('a decided pass resets the unknown run (only CONSECUTIVE unknowns count)', async () => {
    const c = conn(false);
    const failing = build({ docs: [doc('p1', [c])], pdpFail: true });
    const healthy = build({ docs: [doc('p1', [c])], grants: writer('p1') });
    // Same revalidator instance must carry the run; swap its PDP between passes.
    const svc = failing.svc as any;
    await svc.request('sweep'); // unknown #1
    clock += UNKNOWN_GRACE_MS;
    svc.authz = healthy.authz; // the PDP recovers
    await svc.request('sweep'); // decided: write → resets
    svc.authz = failing.authz;
    for (let i = 0; i < UNKNOWN_CAP - 1; i++) {
      await svc.request('sweep');
      clock += UNKNOWN_GRACE_MS;
    }
    expect(c.close).not.toHaveBeenCalled(); // UNKNOWN_CAP-1 new unknowns: not enough, even over a long time
  });

  it('a user-read failure is unknown, never a deny', async () => {
    const c = conn(false);
    const { svc } = build({
      docs: [doc('p1', [c])],
      grants: writer('p1'),
      user: 'throw',
    });
    const s = await svc.request('sweep');
    expect(c.close).not.toHaveBeenCalled();
    expect(s.unknown).toBe(1);
  });

  it('batches one bulk check per user, deduplicating space checks, and chunks at <=128 items', async () => {
    const pages = Array.from({ length: 50 }, (_, i) => `p${i}`); // 50 pages x 3 + 3 space checks = 153 items
    const grants: Record<string, boolean> = {
      [`space:${S1}:edit`]: true,
      [`space:${S1}:view`]: true,
    };
    for (const p of pages)
      Object.assign(grants, {
        [`page:${p}:view`]: true,
        [`page:${p}:edit`]: true,
      });
    const conns = pages.map(() => conn(false));
    const { svc, authz } = build({
      docs: pages.map((p, i) => doc(p, [conns[i]])),
      grants,
    });
    await svc.request('signal');
    expect(authz.tryCheckBulk).toHaveBeenCalledTimes(2);
    for (const call of authz.tryCheckBulk.mock.calls)
      expect((call[1] as unknown[]).length).toBeLessThanOrEqual(128);
    expect(conns.every((c) => c.close.mock.calls.length === 0)).toBe(true);
  });

  it('skips connections that have not authenticated yet (no context.user)', async () => {
    const c = { readOnly: false, context: {}, close: jest.fn() };
    const { svc, authz } = build({ docs: [doc('p1', [c as any])] });
    const s = await svc.request('signal');
    expect(s.checked).toBe(0);
    expect(authz.tryCheckBulk).not.toHaveBeenCalled();
  });
});

describe('LiveAccessRevalidator — socket.io plane', () => {
  it('leaves only the space rooms the user can no longer view', async () => {
    const s1 = sock(U1, ['space-s1', 'space-s2']);
    const { svc } = build({ sockets: [s1], grants: { 'space:s1:view': true } });
    const s = await svc.request('signal');
    expect(s1.leave).toHaveBeenCalledTimes(1);
    expect(s1.leave).toHaveBeenCalledWith('space-s2');
    expect(s.left).toBe(1);
  });

  it('disconnects the sockets of a disabled user', async () => {
    const s1 = sock(U1, ['space-s1']);
    const { svc } = build({
      sockets: [s1],
      user: { id: U1, deactivatedAt: new Date() },
    });
    const s = await svc.request('signal');
    expect(s1.disconnect).toHaveBeenCalledWith(true);
    expect(s.disconnected).toBe(1);
  });

  it('keeps rooms on a PDP failure until the unknown cap, then leaves', async () => {
    const s1 = sock(U1, ['space-s1']);
    const { svc } = build({ sockets: [s1], pdpFail: true });
    for (let i = 1; i < UNKNOWN_CAP; i++) {
      await svc.request('sweep');
      expect(s1.leave).not.toHaveBeenCalled();
      clock += UNKNOWN_GRACE_MS / 2;
    }
    await svc.request('sweep');
    expect(s1.leave).toHaveBeenCalledWith('space-s1');
  });
});

describe('LiveAccessRevalidator — scheduling', () => {
  it('a caller always gets a pass that started after its call; concurrent callers share the queued pass', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const userRepo = {
      findById: jest.fn(async () => {
        await gate;
        return { id: U1, deactivatedAt: null, deletedAt: null };
      }),
    };
    const c = conn(false);
    const svc = new LiveAccessRevalidator(
      { getResidentDocuments: () => [doc('p1', [c])].values() } as any,
      { server: undefined } as any,
      userRepo as any,
      { findById: async (id: string) => ({ id, spaceId: S1 }) } as any,
      pdp(writer('p1')) as any,
      'remote',
    );
    const first = svc.request('signal');
    const second = svc.request('signal');
    const third = svc.request('signal');
    expect(second).toBe(third); // one queued pass for everyone who arrived during the running one
    release();
    await Promise.all([first, second]);
    expect(userRepo.findById).toHaveBeenCalledTimes(2); // exactly two passes
  });

  it('does not arm a sweep outside remote mode, and stops cleanly', () => {
    const native = new LiveAccessRevalidator(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      'native',
    );
    native.onModuleInit();
    expect((native as any).sweepTimer).toBeNull();
    const remote = build({}).svc;
    remote.onModuleInit();
    expect((remote as any).sweepTimer).not.toBeNull();
    remote.onModuleDestroy();
  });
});

describe('LiveAccessRevalidator never widens (static)', () => {
  // Code only: the doc comments state the invariant in the same words.
  const src = fs
    .readFileSync(path.join(__dirname, 'live-access.revalidator.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  it('never sets readOnly to false', () => {
    expect(src).not.toMatch(/readOnly\s*=\s*false/);
  });
  it('never joins a room', () => {
    expect(src).not.toMatch(/\.join\(|socketsJoin/);
  });
});
