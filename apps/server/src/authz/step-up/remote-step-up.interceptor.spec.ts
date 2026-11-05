import { CallHandler, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import type { AuthzMode } from '../mode/authz-mode';
import { RemoteStepUpInterceptor, STEP_UP_REQUIRED_CODE } from './remote-step-up.interceptor';
import { REMOTE_STEP_UP_ROUTES, purgesPermanently, stepUpRoutesOf } from './remote-step-up.table';
import { MAX_FRESH_WINDOW_SECONDS } from './session-freshness';

/**
 * RemoteStepUpInterceptor (wiki-v2 #713) — NOT upstream Docmost code.
 *
 * Parametrised over EVERY key of the table, so a new entry is covered the moment it is added. In remote mode a gated
 * request passes only when the request's OWN session row records a freshness whose window has not lapsed; every other
 * case is `403 {code: 'step_up_required'}` (never a 401, which the SPA would answer by silently re-minting) before the
 * handler runs. Native mode, a non-HTTP context and every route outside the table pass through without a read.
 */
const USER_ID = '0198c2a1-0000-7000-8000-000000000001';
const OTHER_USER_ID = '0198c2a1-0000-7000-8000-000000000002';
const WORKSPACE_ID = '0198c2a1-0000-7000-8000-0000000000aa';
const now = () => Math.floor(Date.now() / 1000);

interface Row {
  id: string;
  userId: string;
  workspaceId: string;
  metadata: unknown;
  createdAt: Date;
  revokedAt?: Date | null;
}

/** An in-memory UserSessionRepo: the two upstream reads a session-freshness check could plausibly use. */
function sessionRepo(rows: Row[]) {
  const live = (r: Row) => !r.revokedAt;
  return {
    findActiveById: jest.fn(async (id: string) => rows.find((r) => r.id === id && live(r))),
    findActiveByUser: jest.fn(async (userId: string, workspaceId: string) =>
      rows
        .filter((r) => r.userId === userId && r.workspaceId === workspaceId && live(r))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    ),
  };
}

const fresh = () => ({ authTime: now() - 60, freshUntil: now() + 7140 });
const stale = () => ({ authTime: now() - 7300, freshUntil: now() - 100 });
const row = (id: string, metadata: unknown, over: Partial<Row> = {}): Row => ({
  id,
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
  metadata,
  createdAt: new Date(),
  ...over,
});

type Req = { body?: unknown; user?: unknown; raw: { sessionId?: unknown } };
const req = (sessionId: unknown, body: unknown = { pageId: 'p1' }): Req => ({
  body,
  user: { user: { id: USER_ID }, workspace: { id: WORKSPACE_ID } },
  raw: { sessionId },
});

const namedClass = (name: string) => ({ [name]: class {} })[name];
const namedFn = (name: string) => ({ [name]: () => undefined })[name];
const ctx = (key: string, r: Req, type = 'http'): ExecutionContext => {
  const [cls, handler] = key.split('.');
  return {
    getType: () => type,
    getClass: () => namedClass(cls),
    getHandler: () => namedFn(handler),
    switchToHttp: () => ({ getRequest: () => r }),
  } as unknown as ExecutionContext;
};

/** A request the gate applies to: the permanent branch for the purge keys, any body for the rest. */
const gatedBody = (key: string) =>
  REMOTE_STEP_UP_ROUTES.get(key)!.when ? { pageId: 'p1', permanentlyDelete: true } : { pageId: 'p1' };

function setup(mode: AuthzMode, rows: Row[]) {
  const repo = sessionRepo(rows);
  const interceptor = new RemoteStepUpInterceptor(mode, repo as any);
  const handler = jest.fn(() => of('handled'));
  const next: CallHandler = { handle: handler };
  const run = (key: string, r: Req, type?: string) => lastValueFrom(interceptor.intercept(ctx(key, r, type), next));
  return { run, handler, repo };
}

async function expectStepUp(p: Promise<unknown>): Promise<void> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ForbiddenException);
  expect((err as ForbiddenException).getStatus()).toBe(403);
  expect((err as ForbiddenException).getResponse()).toEqual({ message: 'Recent sign-in required', code: STEP_UP_REQUIRED_CODE });
}

const KEYS = [...REMOTE_STEP_UP_ROUTES.keys()];

describe('RemoteStepUpInterceptor — every table key, remote mode', () => {
  it.each(KEYS)('%s: a fresh session passes to the handler', async (key) => {
    const { run, handler } = setup('remote', [row('s1', fresh())]);
    await expect(run(key, req('s1', gatedBody(key)))).resolves.toBe('handled');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it.each(KEYS)('%s: a lapsed window is 403 step_up_required and the handler never runs', async (key) => {
    const { run, handler } = setup('remote', [row('s1', stale())]);
    await expectStepUp(run(key, req('s1', gatedBody(key))));
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('RemoteStepUpInterceptor — fails closed on every non-fresh shape', () => {
  const key = 'PageRestrictionController.removeRestriction';
  it.each<[string, Row[], unknown]>([
    ['no metadata (a session minted without freshness)', [row('s1', null)], 's1'],
    ['garbled metadata', [row('s1', '{"authTime":')], 's1'],
    ['metadata without freshUntil', [row('s1', { authTime: now() })], 's1'],
    ['a string freshUntil', [row('s1', { authTime: now(), freshUntil: String(now() + 600) })], 's1'],
    ['a future authTime', [row('s1', { authTime: now() + 3600, freshUntil: now() + 7200 })], 's1'],
    ['a window wider than the fork’s 24h ceiling', [row('s1', { authTime: now() - 10, freshUntil: now() - 10 + MAX_FRESH_WINDOW_SECONDS + 1 })], 's1'],
    ['freshUntil exactly now', [row('s1', { authTime: now() - 600, freshUntil: now() })], 's1'],
    ['no session id on the request (a token without sessionId)', [row('s1', fresh())], undefined],
    ['a non-string session id', [row('s1', fresh())], 42],
    ['a revoked row', [row('s1', fresh(), { revokedAt: new Date() })], 's1'],
    ['an unknown session id', [row('s1', fresh())], 's2'],
    ['another user’s row', [row('s1', fresh(), { userId: OTHER_USER_ID })], 's1'],
    ['a row in another workspace', [row('s1', fresh(), { workspaceId: OTHER_USER_ID })], 's1'],
  ])('%s ⇒ 403', async (_label, rows, sessionId) => {
    const { run, handler } = setup('remote', rows);
    await expectStepUp(run(key, req(sessionId)));
    expect(handler).not.toHaveBeenCalled();
  });

  it('a JSON-string metadata (jest’s driver) that is fresh passes', async () => {
    const { run } = setup('remote', [row('s1', JSON.stringify(fresh()))]);
    await expect(run(key, req('s1'))).resolves.toBe('handled');
  });

  it('a request with no resolved user is refused', async () => {
    const { run } = setup('remote', [row('s1', fresh())]);
    await expectStepUp(run(key, { body: {}, raw: { sessionId: 's1' } }));
  });
});

describe('RemoteStepUpInterceptor — freshness is per session row, never per user (the key #713 property)', () => {
  it('an OLD session stays refused after a NEW fresh session is minted for the same user', async () => {
    const older = row('s-old', stale(), { createdAt: new Date(Date.now() - 86_400_000) });
    const newer = row('s-new', fresh(), { createdAt: new Date() });
    const { run, handler } = setup('remote', [older, newer]);
    const key = 'PageController.delete';
    const purge = { pageId: 'p1', permanentlyDelete: true };
    await expectStepUp(run(key, req('s-old', purge)));
    expect(handler).not.toHaveBeenCalled();
    await expect(run(key, req('s-new', purge))).resolves.toBe('handled');
    // …and an old row minted with NO freshness at all is refused too.
    const bare = row('s-bare', null, { createdAt: new Date(Date.now() - 1000) });
    const second = setup('remote', [bare, row('s-new2', fresh())]);
    await expectStepUp(second.run(key, req('s-bare', purge)));
  });

  it('reads exactly the request’s own row by id', async () => {
    const { run, repo } = setup('remote', [row('s1', fresh())]);
    await run('SpaceController.updateSpace', req('s1', { spaceId: 'sp' }));
    expect(repo.findActiveById).toHaveBeenCalledWith('s1');
    expect(repo.findActiveByUser).not.toHaveBeenCalled();
  });
});

describe('RemoteStepUpInterceptor — the purge predicate (PageController.delete, conditionalDelete)', () => {
  it.each(['PageController.delete', 'ConditionalPageOpsController.conditionalDelete'])(
    '%s: a trash (flag absent, null, false) passes a stale session without a read',
    async (key) => {
      for (const body of [{ pageId: 'p1' }, { pageId: 'p1', permanentlyDelete: null }, { pageId: 'p1', permanentlyDelete: false }]) {
        const { run, repo } = setup('remote', [row('s1', stale())]);
        await expect(run(key, req('s1', body))).resolves.toBe('handled');
        expect(repo.findActiveById).not.toHaveBeenCalled();
      }
    },
  );

  it.each(['PageController.delete', 'ConditionalPageOpsController.conditionalDelete'])(
    '%s: permanentlyDelete true — or any non-false value — is gated',
    async (key) => {
      for (const flag of [true, 'true', 1, {}]) {
        const { run, handler } = setup('remote', [row('s1', stale())]);
        await expectStepUp(run(key, req('s1', { pageId: 'p1', permanentlyDelete: flag })));
        expect(handler).not.toHaveBeenCalled();
      }
    },
  );

  it('purgesPermanently reads only a plain object’s own flag', () => {
    expect(purgesPermanently({ permanentlyDelete: true })).toBe(true);
    expect(purgesPermanently({ permanentlyDelete: false })).toBe(false);
    expect(purgesPermanently(null)).toBe(false);
    expect(purgesPermanently([true])).toBe(false);
    expect(purgesPermanently('permanentlyDelete')).toBe(false);
  });

  it('a throwing predicate gates (fail closed)', async () => {
    const { run } = setup('remote', [row('s1', stale())]);
    const hostile = {
      get permanentlyDelete(): boolean {
        throw new Error('boom');
      },
    };
    await expectStepUp(run('PageController.delete', req('s1', hostile)));
  });
});

describe('RemoteStepUpInterceptor — what it never touches', () => {
  it.each(KEYS)('%s: native (standalone) mode passes a stale session without a read', async (key) => {
    const { run, handler, repo } = setup('native', [row('s1', stale())]);
    await expect(run(key, req('s1', gatedBody(key)))).resolves.toBe('handled');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(repo.findActiveById).not.toHaveBeenCalled();
  });

  it('a non-HTTP context passes through', async () => {
    const { run, repo } = setup('remote', [row('s1', stale())]);
    await expect(run('PageRestrictionController.restrict', req('s1'), 'ws')).resolves.toBe('handled');
    expect(repo.findActiveById).not.toHaveBeenCalled();
  });

  it.each([
    'PageRestrictionController.restrictionPreview',
    'PageController.restore',
    'SpaceController.getSpaceInfo',
    'ExportController.exportPage',
    'ExportController.exportSpace', // a read: never stepped up (#713 review)
    'OtherController.updateSpace',
  ])('%s (not in the table) passes a stale session without a read', async (key) => {
    const { run, repo } = setup('remote', [row('s1', stale())]);
    await expect(run(key, req('s1'))).resolves.toBe('handled');
    expect(repo.findActiveById).not.toHaveBeenCalled();
  });

  it('the kinds partition the table', () => {
    const all = (['purge', 'pageAcl', 'spaceSettings'] as const).flatMap((k) => [...stepUpRoutesOf(k)]);
    expect(all.sort()).toEqual([...KEYS].sort());
  });
});
