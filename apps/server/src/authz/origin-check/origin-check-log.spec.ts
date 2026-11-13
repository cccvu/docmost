import { FORK_ORIGIN_CHECK_REFUSED_TOKEN, logOriginCheckRefused, originCheckLogSink, resetOriginCheckLogForTests } from './origin-check-log';

/**
 * wiki-v2 #655: the refusal line carries signal SHAPES only (fixed enums), never a header value, and is rate-limited
 * per surface so one sender cannot flood the log or crowd the other surface out.
 */
describe('FORK_ORIGIN_CHECK_REFUSED line (#655)', () => {
  let lines: string[];
  let spy: jest.SpyInstance;
  beforeEach(() => {
    jest.useFakeTimers();
    resetOriginCheckLogForTests();
    lines = [];
    spy = jest.spyOn(originCheckLogSink, 'warn').mockImplementation((l) => void lines.push(l));
  });
  afterEach(() => {
    spy.mockRestore();
    jest.useRealTimers();
  });

  const parsed = (line: string) => {
    expect(line.startsWith(`${FORK_ORIGIN_CHECK_REFUSED_TOKEN} `)).toBe(true);
    return JSON.parse(line.slice(FORK_ORIGIN_CHECK_REFUSED_TOKEN.length + 1));
  };

  it('writes the surface, the method and the signal shapes, and no header value', () => {
    logOriginCheckRefused(
      'http',
      {
        host: 'secret-host.example',
        'sec-fetch-site': 'same-site',
        origin: 'https://evil-origin.example',
        referer: 'https://evil-origin.example/secret-path?token=abc',
        cookie: 'authToken=secret-cookie',
      },
      'post',
    );
    expect(lines).toHaveLength(1);
    expect(parsed(lines[0])).toEqual({ surface: 'http', method: 'POST', secFetchSite: 'same-site', origin: 'present', referer: 'present' });
    for (const leak of ['secret-host', 'evil-origin', 'secret-path', 'token=abc', 'secret-cookie']) expect(lines[0]).not.toContain(leak);
  });

  it('maps an unknown Sec-Fetch-Site and an unknown verb to `other`, Origin null to `null`, and a socket has no method', () => {
    logOriginCheckRefused('http', { 'sec-fetch-site': 'evil\nvalue', origin: 'null' }, 'PROPFIND');
    logOriginCheckRefused('socket', { origin: ['https://a.example', 'https://b.example'] });
    expect(parsed(lines[0])).toEqual({ surface: 'http', method: 'other', secFetchSite: 'other', origin: 'null', referer: 'absent' });
    expect(parsed(lines[1])).toEqual({ surface: 'socket', secFetchSite: 'absent', origin: 'present', referer: 'absent' });
  });

  it('is rate-limited per surface: 30 lines a minute, then one log_suppressed count; the other surface keeps its own quota', () => {
    for (let i = 0; i < 40; i++) logOriginCheckRefused('http', { origin: 'https://evil.example' }, 'POST');
    logOriginCheckRefused('socket', { origin: 'https://evil.example' });
    expect(lines).toHaveLength(31);
    expect(parsed(lines[30]).surface).toBe('socket');
    jest.advanceTimersByTime(60_000);
    expect(lines).toHaveLength(32);
    expect(parsed(lines[31])).toEqual({ surface: 'http', reason: 'log_suppressed', count: 10 });
  });
});
