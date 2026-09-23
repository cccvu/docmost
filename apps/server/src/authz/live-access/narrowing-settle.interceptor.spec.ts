import { Logger } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { maxCommittedPosition } from '../../service-bridge/authz-change-feed.service';
import {
  AUTHZ_PROPAGATION_HEADER,
  NarrowingSettleInterceptor,
  narrowingSettleTimeoutMs,
  REQUEST_BUDGET_MS,
  REVALIDATE_WAIT_MS,
} from './narrowing-settle.interceptor';

// The revalidator is injected as a stub; don't load the collab gateway's ESM (Hocuspocus/lib0) graph.
jest.mock('./live-access.revalidator', () => ({
  LiveAccessRevalidator: class {},
}));
jest.mock('../../service-bridge/authz-change-feed.service', () => ({
  maxCommittedPosition: jest.fn(async () => '42.7'),
}));
const mockedFence = maxCommittedPosition as jest.MockedFunction<
  typeof maxCommittedPosition
>;

/**
 * #501 Part B: after a narrowing handler succeeds (remote mode), the response waits for the platform to settle the
 * relay to the global fence, re-checks this node's live connections on `confirmed`, and carries
 * `Authz-Propagation`. It never throws, never touches the status or body, and leaves errors alone.
 */

class PageRestrictionController {
  restrict() {}
}
class PageController {
  getPage() {}
  movePage() {}
}

function ctx(controller: new () => object, handler: string) {
  const reply = {
    sent: false,
    headers: {} as Record<string, string>,
    header(k: string, v: string) {
      this.headers[k] = v;
    },
  };
  const context = {
    getType: () => 'http',
    getClass: () => controller,
    getHandler: () =>
      (controller.prototype as Record<string, unknown>)[handler],
    switchToHttp: () => ({ getResponse: () => reply }),
  };
  return { context: context as any, reply };
}

function build(
  opts: { mode?: string; settle?: jest.Mock; signal?: jest.Mock } = {},
) {
  const authz = {
    settleProjection:
      opts.settle ?? jest.fn(async () => ({ status: 'confirmed' })),
  };
  const liveAccess = { signal: opts.signal ?? jest.fn(async () => ({})) };
  const icpt = new NarrowingSettleInterceptor(
    {} as any,
    authz as any,
    liveAccess as any,
    (opts.mode ?? 'remote') as any,
  );
  return { icpt, authz, liveAccess };
}

const run = (
  icpt: NarrowingSettleInterceptor,
  context: any,
  body: unknown = { data: 'x' },
) => lastValueFrom(icpt.intercept(context, { handle: () => of(body) }));

let warn: jest.SpyInstance;
beforeEach(() => {
  // Two reads per request: the fence before the handler ('41.0') and after it ('42.7') — it moved, so there is
  // something to settle. Tests that need another shape reset it.
  let reads = 0;
  mockedFence
    .mockReset()
    .mockImplementation(async () => (++reads % 2 === 1 ? '41.0' : '42.7'));
  warn = jest
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
  jest.restoreAllMocks();
});

describe('NarrowingSettleInterceptor', () => {
  it('confirmed: fences at the max committed position, re-checks live sessions, sets the header, body untouched', async () => {
    const { icpt, authz, liveAccess } = build();
    const { context, reply } = ctx(PageRestrictionController, 'restrict');
    const body = { data: { ok: true } };
    expect(await run(icpt, context, body)).toBe(body);
    expect(authz.settleProjection).toHaveBeenCalledWith('42.7', 3000);
    expect(liveAccess.signal).toHaveBeenCalledWith('narrowing');
    expect(reply.headers[AUTHZ_PROPAGATION_HEADER]).toBe('confirmed');
  });

  it('pending from the platform (or a 404/timeout it maps to pending): header pending, no live-session pass', async () => {
    const settle = jest.fn(async () => ({
      status: 'pending',
      reason: 'timeout',
    }));
    const { icpt, liveAccess } = build({ settle });
    const { context, reply } = ctx(PageRestrictionController, 'restrict');
    await run(icpt, context);
    expect(reply.headers[AUTHZ_PROPAGATION_HEADER]).toBe('pending');
    expect(liveAccess.signal).not.toHaveBeenCalled();
    const line = String(warn.mock.calls[0][0]);
    expect(line).toMatch(
      /route=PageRestrictionController\.restrict position=42\.7 reason=timeout/,
    );
    // The platform answered (and logged the alarmed line itself): the fork must not count it twice.
    expect(line).not.toContain('AUTHZ_PROPAGATION_PENDING');
  });

  it('a pending with NO platform verdict (settle-*) is logged here with the alarmed token', async () => {
    const settle = jest.fn(async () => ({
      status: 'pending',
      reason: 'settle-http-404',
    }));
    const { icpt } = build({ settle });
    const { context, reply } = ctx(PageRestrictionController, 'restrict');
    await run(icpt, context);
    expect(reply.headers[AUTHZ_PROPAGATION_HEADER]).toBe('pending');
    expect(String(warn.mock.calls[0][0])).toMatch(
      /^AUTHZ_PROPAGATION_PENDING reason=settle-http-404 route=PageRestrictionController\.restrict position=42\.7/,
    );
  });

  it('a fence that cannot be read after the handler is pending (alarmed), never an error', async () => {
    mockedFence
      .mockReset()
      .mockResolvedValueOnce('41.0')
      .mockRejectedValueOnce(new Error('db down'));
    const { icpt, authz } = build();
    const { context, reply } = ctx(PageRestrictionController, 'restrict');
    await expect(run(icpt, context)).resolves.toEqual({ data: 'x' });
    expect(reply.headers[AUTHZ_PROPAGATION_HEADER]).toBe('pending');
    expect(authz.settleProjection).not.toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toMatch(
      /^AUTHZ_PROPAGATION_PENDING reason=settle-fence-unreadable/,
    );
  });

  it('a request that committed no outbox row (fence unchanged: a same-parent reorder, a no-op) settles nothing and sends no header', async () => {
    mockedFence.mockReset().mockResolvedValue('42.7');
    const { icpt, authz, liveAccess } = build();
    const { context, reply } = ctx(PageController, 'movePage');
    const body = { data: 'moved' };
    expect(await run(icpt, context, body)).toBe(body);
    expect(authz.settleProjection).not.toHaveBeenCalled();
    expect(liveAccess.signal).not.toHaveBeenCalled();
    expect(reply.headers).toEqual({}); // unknown — never confirmed
  });

  it('reads the "before" fence BEFORE the handler runs', async () => {
    const order: string[] = [];
    mockedFence.mockReset().mockImplementation(async () => {
      order.push('fence');
      return order.length === 1 ? '41.0' : '42.7';
    });
    const { icpt } = build();
    const { context } = ctx(PageRestrictionController, 'restrict');
    await lastValueFrom(
      icpt.intercept(context, {
        handle: () => {
          order.push('handler');
          return of({});
        },
      }),
    );
    expect(order).toEqual(['fence', 'handler', 'fence']);
  });

  it('an unreadable "before" fence never skips: it settles as usual', async () => {
    mockedFence
      .mockReset()
      .mockRejectedValueOnce(new Error('db blip'))
      .mockResolvedValue('42.7');
    const { icpt, authz } = build();
    const { context, reply } = ctx(PageRestrictionController, 'restrict');
    await run(icpt, context);
    expect(authz.settleProjection).toHaveBeenCalledWith('42.7', 3000);
    expect(reply.headers[AUTHZ_PROPAGATION_HEADER]).toBe('confirmed');
  });

  it('leaves a failed handler alone: the error passes through, nothing is settled, no header', async () => {
    const { icpt, authz } = build();
    const { context, reply } = ctx(PageRestrictionController, 'restrict');
    const boom = new Error('403');
    await expect(
      lastValueFrom(
        icpt.intercept(context, { handle: () => throwError(() => boom) }),
      ),
    ).rejects.toBe(boom);
    expect(authz.settleProjection).not.toHaveBeenCalled();
    expect(reply.headers).toEqual({});
  });

  it('passes through a route that is not in the narrowing table', async () => {
    const { icpt, authz } = build();
    const { context, reply } = ctx(PageController, 'getPage');
    await run(icpt, context);
    expect(authz.settleProjection).not.toHaveBeenCalled();
    expect(reply.headers).toEqual({});
  });

  it('passes through outside remote mode (no platform to settle with)', async () => {
    const { icpt, authz } = build({ mode: 'native' });
    const { context, reply } = ctx(PageRestrictionController, 'restrict');
    await run(icpt, context);
    expect(authz.settleProjection).not.toHaveBeenCalled();
    expect(reply.headers).toEqual({});
  });

  it('AUTHZ_NARROWING_SETTLE_TIMEOUT_MS=0 turns it into a pass-through (the rollback switch)', async () => {
    const prev = process.env.AUTHZ_NARROWING_SETTLE_TIMEOUT_MS;
    process.env.AUTHZ_NARROWING_SETTLE_TIMEOUT_MS = '0';
    try {
      const { icpt, authz } = build();
      const { context, reply } = ctx(PageRestrictionController, 'restrict');
      await run(icpt, context);
      expect(authz.settleProjection).not.toHaveBeenCalled();
      expect(reply.headers).toEqual({});
    } finally {
      if (prev === undefined)
        delete process.env.AUTHZ_NARROWING_SETTLE_TIMEOUT_MS;
      else process.env.AUTHZ_NARROWING_SETTLE_TIMEOUT_MS = prev;
    }
  });

  it('keeps the whole request inside its budget: a slow handler leaves less (or no) wait for the settle', async () => {
    const t0 = 1_000_000;
    const now = jest.spyOn(Date, 'now').mockReturnValue(t0);
    const settle = jest.fn(async () => ({ status: 'confirmed' }));
    const { icpt } = build({ settle });
    const { context } = ctx(PageRestrictionController, 'restrict');
    const out = icpt.intercept(context, { handle: () => of({}) }); // startedAt = t0
    now.mockReturnValue(t0 + 4000); // the handler took 4 s: 6000 - 1500 - 4000 = 500 ms left to wait
    await lastValueFrom(out);
    expect(settle).toHaveBeenCalledWith('42.7', 500);

    const out2 = icpt.intercept(context, { handle: () => of({}) });
    now.mockReturnValue(t0 + 4000 + 5000); // this one took 5 s: nothing left → check once, do not wait
    await lastValueFrom(out2);
    expect(settle).toHaveBeenLastCalledWith('42.7', 0);
    expect(REQUEST_BUDGET_MS).toBeLessThan(8000); // under the platform's relay / service-client timeout
  });

  it('bounds the live-session re-check: a slow pass does not hold the response past REVALIDATE_WAIT_MS', async () => {
    jest.useFakeTimers();
    try {
      const signal = jest.fn(() => new Promise(() => undefined)); // never settles
      const { icpt } = build({ signal });
      const { context, reply } = ctx(PageRestrictionController, 'restrict');
      const done = run(icpt, context);
      await jest.advanceTimersByTimeAsync(REVALIDATE_WAIT_MS + 10);
      await done;
      expect(reply.headers[AUTHZ_PROPAGATION_HEADER]).toBe('confirmed'); // the PDP enforces it already
    } finally {
      jest.useRealTimers();
    }
  });

  it('a failing live-session pass does not change the verdict (the PDP already enforces the change)', async () => {
    const signal = jest.fn(async () => {
      throw new Error('pass failed');
    });
    const { icpt } = build({ signal });
    const { context, reply } = ctx(PageRestrictionController, 'restrict');
    await run(icpt, context);
    expect(reply.headers[AUTHZ_PROPAGATION_HEADER]).toBe('confirmed');
  });

  it('caps the live-session wait by what is left of the request budget', async () => {
    const t0 = 2_000_000;
    const now = jest.spyOn(Date, 'now').mockReturnValue(t0);
    const signal = jest.fn(() => new Promise(() => undefined)); // never settles
    const settle = jest.fn(async () => {
      now.mockReturnValue(t0 + REQUEST_BUDGET_MS); // the settle used the whole budget
      return { status: 'confirmed' };
    });
    const { icpt } = build({ settle, signal });
    const { context, reply } = ctx(PageRestrictionController, 'restrict');
    await run(icpt, context); // real timers: a 0 ms wait, so this returns at once
    expect(signal).toHaveBeenCalledWith('narrowing');
    expect(reply.headers[AUTHZ_PROPAGATION_HEADER]).toBe('confirmed');
  });

  it('passes through a non-HTTP context', async () => {
    const { icpt, authz } = build();
    const { context } = ctx(PageRestrictionController, 'restrict');
    context.getType = () => 'ws';
    await run(icpt, context);
    expect(authz.settleProjection).not.toHaveBeenCalled();
    expect(mockedFence).not.toHaveBeenCalled();
  });

  it('does not set a header on a reply that was already sent', async () => {
    const { icpt } = build();
    const { context, reply } = ctx(PageRestrictionController, 'restrict');
    reply.sent = true;
    await run(icpt, context);
    expect(reply.headers).toEqual({});
  });
});

describe('narrowingSettleTimeoutMs', () => {
  it('defaults to 3000, clamps to 5000, keeps 0, and falls back on junk', () => {
    expect(narrowingSettleTimeoutMs(undefined)).toBe(3000);
    expect(narrowingSettleTimeoutMs('')).toBe(3000);
    expect(narrowingSettleTimeoutMs('0')).toBe(0);
    expect(narrowingSettleTimeoutMs('1200')).toBe(1200);
    expect(narrowingSettleTimeoutMs('99999')).toBe(5000);
    expect(narrowingSettleTimeoutMs('-1')).toBe(3000);
    expect(narrowingSettleTimeoutMs('abc')).toBe(3000);
  });
});
