import { COLLAB_SOCKET_LIMIT_LOGS_PER_MINUTE } from './limits';
import { RateLimitedWarn, SOCKET_LIMITS, SocketLimitLog, type SocketLimit } from './socket-limit-log';

/**
 * #810 (D3, L1): `COLLAB_SOCKET_LIMIT` lines are rate-limited per limit in fixed 60 s windows, and a window that
 * suppressed lines writes its `log_suppressed` counts at its end from an unref'd timer, even if nothing is logged after.
 *
 * Mutation arms (recorded in the #810 notes): one counter shared by every limit turns "junk on one limit" red; no
 * timer turns "the final count" red; dropping the `unref` turns "the timer is unref'd" red.
 */
const QUOTA = COLLAB_SOCKET_LIMIT_LOGS_PER_MINUTE;
const suppressedLines = (lines: string[]) => lines.filter((l) => l.includes('"log_suppressed"'));

describe('#810 SocketLimitLog: one window per limit', () => {
  afterEach(() => jest.useRealTimers());

  const sink = () => {
    const lines: string[] = [];
    let now = 1_000_000;
    const log = new SocketLimitLog({ warn: (m) => lines.push(m) }, () => now);
    return { lines, log, advance: (ms: number) => (now += ms) };
  };

  it('about 10 lines per limit a minute', () => {
    expect(QUOTA).toBe(10);
  });

  it("junk on one limit cannot suppress another limit's lines", () => {
    jest.useFakeTimers();
    const { lines, log } = sink();
    for (let i = 0; i < QUOTA + 50; i++) log.log('preauth_sockets', { held: 512 });
    for (let i = 0; i < QUOTA + 50; i++) log.log('frame_address', { frameBytes: 3 });
    log.log('auth_rate', { userId: 'u1' });
    log.log('user_sync_budget', { userId: 'u2' });
    expect(lines.filter((l) => l.includes('"preauth_sockets"'))).toHaveLength(QUOTA);
    expect(lines.filter((l) => l.includes('"frame_address"'))).toHaveLength(QUOTA);
    expect(lines.slice(-2)).toEqual([
      'COLLAB_SOCKET_LIMIT {"limit":"auth_rate","userId":"u1"}',
      'COLLAB_SOCKET_LIMIT {"limit":"user_sync_budget","userId":"u2"}',
    ]);
  });

  it('every limit the bounds log has its own window, and log_suppressed is not one of them', () => {
    expect(new Set(SOCKET_LIMITS).size).toBe(SOCKET_LIMITS.length);
    expect(SOCKET_LIMITS).not.toContain('log_suppressed');
    jest.useFakeTimers();
    const { lines, log } = sink();
    for (const limit of SOCKET_LIMITS) for (let i = 0; i < QUOTA; i++) log.log(limit);
    expect(lines).toHaveLength(SOCKET_LIMITS.length * QUOTA);
  });

  it('a value outside SOCKET_LIMITS (only a cast can pass one) shares one window, so it never adds keys', () => {
    jest.useFakeTimers();
    const { lines, log } = sink();
    for (let i = 0; i < 1000; i++) log.log(`client-${i}` as SocketLimit);
    expect(lines).toHaveLength(QUOTA);
    log.log('auth_rate', { userId: 'u1' });
    expect(lines).toHaveLength(QUOTA + 1);
    jest.advanceTimersByTime(60_000);
    expect(suppressedLines(lines)).toEqual(['COLLAB_SOCKET_LIMIT {"limit":"log_suppressed","of":"unlisted","count":990}']);
  });
});

describe('#810 SocketLimitLog: the final suppressed counts are written at the end of the window', () => {
  afterEach(() => jest.useRealTimers());

  it('by the timer, with no further log() call: one line per limit that suppressed, with its exact count', () => {
    jest.useFakeTimers({ now: 5_000_000 });
    const lines: string[] = [];
    const log = new SocketLimitLog({ warn: (m) => lines.push(m) });
    for (let i = 0; i < QUOTA + 7; i++) log.log('preauth_bytes', { bytes: 1 });
    for (let i = 0; i < QUOTA + 3; i++) log.log('auth_rate', { userId: 'u' });
    log.log('ws_error', { code: 'unknown' }); // within its quota: no summary
    expect(jest.getTimerCount()).toBe(1); // one timer for the window, not one per suppression
    jest.advanceTimersByTime(59_999);
    expect(suppressedLines(lines)).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(suppressedLines(lines)).toEqual([
      'COLLAB_SOCKET_LIMIT {"limit":"log_suppressed","of":"preauth_bytes","count":7}',
      'COLLAB_SOCKET_LIMIT {"limit":"log_suppressed","of":"auth_rate","count":3}',
    ]);
    expect(jest.getTimerCount()).toBe(0);
    // the next line opens a fresh window: written, and no duplicate summary
    log.log('preauth_bytes', { bytes: 2 });
    jest.advanceTimersByTime(120_000);
    expect(suppressedLines(lines)).toHaveLength(2);
    expect(lines[lines.length - 1]).toBe('COLLAB_SOCKET_LIMIT {"limit":"preauth_bytes","bytes":2}');
  });

  it('the timer fires at the end of the window the suppression fell in, not a minute after it', () => {
    jest.useFakeTimers({ now: 5_000_000 });
    const lines: string[] = [];
    const log = new SocketLimitLog({ warn: (m) => lines.push(m) });
    log.log('socket_empty');
    jest.advanceTimersByTime(50_000);
    for (let i = 0; i < QUOTA; i++) log.log('socket_empty');
    expect(suppressedLines(lines)).toEqual([]);
    jest.advanceTimersByTime(10_000);
    expect(suppressedLines(lines)).toEqual(['COLLAB_SOCKET_LIMIT {"limit":"log_suppressed","of":"socket_empty","count":1}']);
  });

  it('a log() in the next window writes the counts first and disarms the timer (never written twice)', () => {
    jest.useFakeTimers({ now: 5_000_000 });
    const lines: string[] = [];
    let now = 5_000_000;
    const log = new SocketLimitLog({ warn: (m) => lines.push(m) }, () => now);
    for (let i = 0; i < QUOTA + 2; i++) log.log('outbound_stalled');
    now += 60_000; // the injected clock moves; the fake timer has not fired yet
    log.log('outbound_stalled');
    expect(lines.slice(QUOTA)).toEqual([
      'COLLAB_SOCKET_LIMIT {"limit":"log_suppressed","of":"outbound_stalled","count":2}',
      'COLLAB_SOCKET_LIMIT {"limit":"outbound_stalled"}',
    ]);
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(600_000);
    expect(suppressedLines(lines)).toHaveLength(1);
  });

  it('a window that suppressed nothing arms no timer', () => {
    jest.useFakeTimers();
    const log = new SocketLimitLog({ warn: () => undefined });
    for (let i = 0; i < QUOTA; i++) log.log('auth_refused', { status: 403 });
    expect(jest.getTimerCount()).toBe(0);
  });

  it("the timer is unref'd, so it never holds the process (or a shutdown) open", () => {
    const handles: NodeJS.Timeout[] = [];
    const real = global.setTimeout;
    const spy = jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      const handle = real(fn, ms);
      handles.push(handle);
      return handle;
    }) as typeof setTimeout);
    const log = new SocketLimitLog({ warn: () => undefined });
    for (let i = 0; i < QUOTA + 1; i++) log.log('invalid_token', { kind: 'expired' });
    spy.mockRestore();
    expect(handles).toHaveLength(1);
    expect(handles[0].hasRef()).toBe(false);
    clearTimeout(handles[0]);
  });
});

describe('#810 RateLimitedWarn (the generic window the update guard shares)', () => {
  afterEach(() => jest.useRealTimers());

  it('builds a line only when it is written', () => {
    jest.useFakeTimers();
    const warn = new RateLimitedWarn<'a'>({ logger: { warn: () => undefined }, perKey: 1, summary: () => 's' });
    const line = jest.fn(() => 'x');
    for (let i = 0; i < 5; i++) warn.warn('a', line);
    expect(line).toHaveBeenCalledTimes(1);
  });
});
