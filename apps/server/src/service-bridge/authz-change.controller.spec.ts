import { ServiceUnavailableException } from '@nestjs/common';
import { AuthzChangeController } from './authz-change.controller';
import { ChangesResult, FeedClosingError, StaleCursorError } from './authz-change-feed.service';

/**
 * The change-feed route at shutdown (#810). The platform polls `changes` in a loop on one keep-alive connection, so a
 * poll answered after the destroy must close that connection (`Connection: close`) and a new one must be refused
 * without parking: otherwise the HTTP server's close never finishes and the process waits for the SIGKILL (live: exit
 * 137 after the 90 s grace, the in-flight request always this route).
 */
const OK: ChangesResult = { events: [], nextCursor: '1.1', head: '1.1', oldestPendingAgeMs: null, dropped: 0 };

function harness(feed: { closing: boolean; getChanges: () => Promise<ChangesResult> }) {
  const headers: Record<string, string> = {};
  const res = { header: (k: string, v: string) => ((headers[k.toLowerCase()] = v), res) };
  const controller = new AuthzChangeController(feed as any, {} as any, {} as any);
  const call = () => controller.changes('0.0', 25_000, 500, res as any);
  return { call, headers };
}

describe('AuthzChangeController.changes at shutdown (#810)', () => {
  it('a running process answers with no connection header (keep-alive stays)', async () => {
    const { call, headers } = harness({ closing: false, getChanges: async () => OK });
    await expect(call()).resolves.toBe(OK);
    expect(headers.connection).toBeUndefined();
  });

  it('a poll woken by the destroy answers 200 and closes its connection', async () => {
    const feed = { closing: false, getChanges: async () => ((feed.closing = true), OK) };
    const { call, headers } = harness(feed);
    await expect(call()).resolves.toBe(OK);
    expect(headers.connection).toBe('close');
  });

  it('a poll after the destroy is a 503 shutting_down, and closes its connection', async () => {
    const feed = {
      closing: true,
      getChanges: async (): Promise<ChangesResult> => {
        throw new FeedClosingError();
      },
    };
    const { call, headers } = harness(feed);
    const err = await call().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as ServiceUnavailableException).getResponse()).toMatchObject({ code: 'shutting_down' });
    expect(headers.connection).toBe('close');
  });

  it('a stale cursor is still the 409 (unchanged)', async () => {
    const feed = {
      closing: false,
      getChanges: async (): Promise<ChangesResult> => {
        throw new StaleCursorError('9.9');
      },
    };
    const { call, headers } = harness(feed);
    const err = (await call().catch((e: unknown) => e)) as { getStatus(): number };
    expect(err.getStatus()).toBe(409);
    expect(headers.connection).toBeUndefined();
  });
});
