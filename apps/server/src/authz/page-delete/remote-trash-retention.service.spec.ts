import { Logger } from '@nestjs/common';
import { spyKysely, SpyQuery } from '../../service-bridge/kysely-spy.testkit';

// PageService's module graph pulls in the collab WebSocket stack (lib0 ESM) that jest cannot parse. Stub it.
jest.mock('../../collaboration/collaboration.gateway', () => ({ CollaborationGateway: class {} }));

import { DEFAULT_RETENTION_DAYS, RemoteTrashRetentionService } from './remote-trash-retention.service';

/**
 * #589 — the remote trash retention, per candidate (mocked database; the real locking and races are
 * `remote-trash-retention.pg.spec.ts`). A candidate's subtree is purged only when, under its locks, EVERY row is
 * trashed, expired and in this workspace, and every space it touches is live and unchanged since the cutoff; anything
 * else is a logged skip. Jobs are queued only after the commit; one failing candidate never stops the run.
 */
const WS = 'ws-1';
const DAY = 24 * 60 * 60 * 1000;
const OLD = new Date(Date.now() - 90 * DAY);
const RECENT = new Date(Date.now() - DAY);

type Row = { id: string; spaceId?: string; workspaceId?: string; deletedAt?: Date | null };
type Opts = {
  workspaces?: { id: string; trashRetentionDays: number | null }[];
  candidates?: string[];
  /** The locked rows per candidate root (default: the root alone, trashed long ago). */
  subtrees?: Record<string, Row[] | 'unlockable'>;
  spaces?: Record<string, { deletedAt?: Date | null; updatedAt?: Date } | 'missing'>;
  deleted?: (root: string, locked: string[]) => string[];
  lockError?: (root: string) => unknown;
};

const build = (opts: Opts = {}) => {
  const calls: string[] = [];
  let root = '';
  let rows: Row[] = [];
  const spy = spyKysely((q: SpyQuery) => {
    if (/set local/i.test(q.sql)) return [];
    if (/from "workspaces"/.test(q.sql)) return opts.workspaces ?? [{ id: WS, trashRetentionDays: null }];
    if (/from "pages" as "p" inner join "spaces"/.test(q.sql)) {
      calls.push(`candidates:${q.parameters.filter((p) => typeof p === 'string').join(',')}`);
      return (opts.candidates ?? ['root-1']).map((id) => ({ id }));
    }
    if (/with recursive "page_descendants"/.test(q.sql)) {
      root = q.parameters[0] as string;
      const sub = opts.subtrees?.[root];
      rows =
        sub === 'unlockable'
          ? [{ id: root }]
          : (sub ?? [{ id: root }]).map((r) => ({ spaceId: 'space-1', workspaceId: WS, deletedAt: OLD, ...r }));
      return rows.map((r) => ({ id: r.id }));
    }
    if (/for update/i.test(q.sql)) {
      const err = opts.lockError?.(root);
      if (err) throw err;
      calls.push(`lock:${root}`);
      return opts.subtrees?.[root] === 'unlockable' ? [] : rows;
    }
    if (/from "spaces"/.test(q.sql) && /for share/i.test(q.sql)) {
      const ids = q.parameters.filter((p) => typeof p === 'string' && p !== WS) as string[];
      return ids
        .filter((id) => opts.spaces?.[id] !== 'missing')
        .map((id) => {
          const s = opts.spaces?.[id];
          return { id, deletedAt: null, updatedAt: OLD, ...(typeof s === 'object' ? s : {}) };
        });
    }
    calls.push(`sql:${q.sql}`);
    return [];
  });
  const pageService = {
    forceDelete: jest.fn(async (id: string, ws: string, trx: unknown) => {
      calls.push(`forceDelete:${id}:${ws}:${trx ? 'trx' : 'no-trx'}`);
      const locked = rows.map((r) => r.id);
      return opts.deleted ? opts.deleted(id, locked) : locked;
    }),
  };
  const queue = {
    add: jest.fn(async (_n: string, data: { pageId: string }) => void calls.push(`job:${data.pageId}:${spy.tx.join('>')}`)),
  };
  const service = new RemoteTrashRetentionService(spy.db, pageService as never, queue as never);
  return { service, calls, spy, pageService, queue };
};

let logs: string[];
beforeEach(() => {
  logs = [];
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => void logs.push(`${level}:${String(args[0])}`));
  }
});
afterEach(() => jest.restoreAllMocks());

describe('RemoteTrashRetentionService — what it purges', () => {
  it('an expired trash subtree in a live, unchanged space: forceDelete(trx) under the locks, jobs only after the commit', async () => {
    const t = build({ subtrees: { 'root-1': [{ id: 'root-1' }, { id: 'child-1' }] } });
    await t.service.cleanupOldTrash();
    expect(t.calls.filter((c) => !c.startsWith('candidates'))).toEqual([
      'lock:root-1',
      'forceDelete:root-1:ws-1:trx',
      'job:root-1:begin>commit',
      'job:child-1:begin>commit',
    ]);
    expect(t.spy.calls.some((q) => /for share/i.test(q.sql) && /from "spaces"/.test(q.sql))).toBe(true);
  });

  it('locks FOR UPDATE (the purge’s lock), bounded by SET LOCAL before it', async () => {
    const t = build();
    await t.service.cleanupOldTrash();
    const sqls = t.spy.calls.map((q) => q.sql);
    const bound = sqls.findIndex((q) => /set local lock_timeout/i.test(q));
    const lock = sqls.findIndex((q) => /for update/i.test(q));
    expect(bound).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(bound);
    expect(sqls[lock]).not.toMatch(/no key update/i);
  });

  it('candidates: expired trash ROOTS (no trashed parent) in live spaces of the workspace', async () => {
    const t = build();
    await t.service.cleanupOldTrash();
    const q = t.spy.calls.find((c) => /from "pages" as "p" inner join "spaces"/.test(c.sql))!;
    expect(q.sql).toMatch(/inner join "spaces" as "s"/);
    expect(q.sql).toMatch(/"s"\."deleted_at" is null/);
    expect(q.sql).toMatch(/"p"\."deleted_at" < \$\d/);
    expect(q.sql).toMatch(/not exists \(select "q"\."id" from "pages" as "q" where "q"\."id" = "p"\."parent_page_id" and "q"\."deleted_at" is not null\)/);
  });

  it(`retention days: the workspace's, else ${DEFAULT_RETENTION_DAYS} — the cutoff is that many days back`, async () => {
    for (const [days, expected] of [
      [null, DEFAULT_RETENTION_DAYS],
      [7, 7],
    ] as const) {
      const t = build({ workspaces: [{ id: WS, trashRetentionDays: days }] });
      await t.service.cleanupOldTrash();
      const q = t.spy.calls.find((c) => /from "pages" as "p" inner join "spaces"/.test(c.sql))!;
      const cutoff = q.parameters.find((p) => p instanceof Date) as Date;
      expect(Math.round((Date.now() - cutoff.getTime()) / DAY)).toBe(expected);
    }
  });
});

describe('RemoteTrashRetentionService — what it skips (nothing deleted, nothing queued)', () => {
  it.each([
    ['live_descendant', { subtrees: { 'root-1': [{ id: 'root-1' }, { id: 'child-1', deletedAt: null }] } }],
    ['not_expired', { subtrees: { 'root-1': [{ id: 'root-1' }, { id: 'child-1', deletedAt: RECENT }] } }],
    ['space_archived', { subtrees: { 'root-1': [{ id: 'root-1' }, { id: 'child-1', spaceId: 'space-2' }] }, spaces: { 'space-2': { deletedAt: new Date() } } }],
    ['space_archived', { spaces: { 'space-1': 'missing' as const } }],
    ['space_recently_changed', { spaces: { 'space-1': { updatedAt: RECENT } } }],
    ['subtree_changed', { subtrees: { 'root-1': 'unlockable' as const } }],
  ])('%s → TRASH_RETENTION_SKIPPED', async (reason, o) => {
    const t = build(o as Opts);
    await t.service.cleanupOldTrash();
    expect(t.pageService.forceDelete).not.toHaveBeenCalled();
    expect(t.queue.add).not.toHaveBeenCalled();
    expect(logs).toContain(`log:TRASH_RETENTION_SKIPPED page=root-1 reason=${reason}`);
  });

  it('a candidate already gone by the time it is locked is skipped silently', async () => {
    const t = build({ subtrees: { 'root-1': [] } });
    await t.service.cleanupOldTrash();
    expect(t.pageService.forceDelete).not.toHaveBeenCalled();
    expect(logs.filter((l) => l.includes('TRASH_RETENTION'))).toEqual([]);
  });
});

describe('RemoteTrashRetentionService — failures', () => {
  it('the deleted set is not the locked set → TRASH_RETENTION_FAILED, rolled back, no job', async () => {
    const t = build({ deleted: (_r, locked) => [...locked, 'extra'] });
    await t.service.cleanupOldTrash();
    expect(t.spy.tx).toEqual(['begin', 'rollback']);
    expect(t.queue.add).not.toHaveBeenCalled();
    expect(logs.some((l) => l.startsWith('error:TRASH_RETENTION_FAILED page=root-1 reason=set_mismatch'))).toBe(true);
  });

  it('one failing candidate (a lock timeout) never stops the run: the next one is purged', async () => {
    const t = build({
      candidates: ['root-1', 'root-2'],
      lockError: (root) => (root === 'root-1' ? Object.assign(new Error('lock timeout'), { code: '55P03' }) : undefined),
    });
    await t.service.cleanupOldTrash();
    expect(t.pageService.forceDelete.mock.calls.map((c) => c[0])).toEqual(['root-2']);
    expect(t.calls).toContain('job:root-2:begin>rollback>begin>commit');
    expect(logs).toContain('error:TRASH_RETENTION_FAILED page=root-1 code=55P03: rolled back, continuing');
  });

  it('a failing workspace scan logs and returns; it never throws out of the interval', async () => {
    const t = build();
    jest.spyOn(t.service, 'candidates').mockRejectedValueOnce(new Error('db down'));
    await expect(t.service.cleanupOldTrash()).resolves.toBeUndefined();
    expect(logs.some((l) => l.startsWith('error:TRASH_RETENTION_FAILED stage=candidates'))).toBe(true);
  });
});
