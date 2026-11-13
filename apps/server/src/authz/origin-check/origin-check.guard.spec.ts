import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { ForkOriginCheckGuard } from './origin-check.guard';
import { ORIGIN_CHECK_REFUSED_MESSAGE } from './origin-check';
import { originCheckLogSink, resetOriginCheckLogForTests } from './origin-check-log';

/**
 * wiki-v2 #655: which requests ForkOriginCheckGuard decides, and with which inputs. The decision table itself is
 * pinned by the shared vectors (origin-check.spec.ts); this pins the gate around it.
 */
const APP_URL = 'https://wiki.example.com';
const HOST = 'wiki.example.com';
const env = { getAppUrl: () => APP_URL } as unknown as EnvironmentService;
const guard = () => new ForkOriginCheckGuard(env);

const ctxOf = (req: { method: string; headers: Record<string, unknown> }, type = 'http'): ExecutionContext =>
  ({
    getType: () => type,
    switchToHttp: () => ({ getRequest: () => req }),
  }) as unknown as ExecutionContext;

const run = (method: string, headers: Record<string, unknown>, type = 'http'): boolean =>
  guard().canActivate(ctxOf({ method, headers }, type));

const refuses = (method: string, headers: Record<string, unknown>) => {
  let err: unknown;
  try {
    run(method, headers);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ForbiddenException);
  expect((err as ForbiddenException).message).toBe(ORIGIN_CHECK_REFUSED_MESSAGE);
};

// The most hostile signals a browser can send: a sandboxed cross-site frame.
const HOSTILE = { host: HOST, 'sec-fetch-site': 'cross-site', origin: 'null' };
const SIBLING = { host: HOST, 'sec-fetch-site': 'same-site', origin: 'https://sibling.example.edu' };

describe('ForkOriginCheckGuard (#655)', () => {
  it('passes a non-HTTP context (socket.io messages: their handshake is checked by the socket middleware)', () => {
    expect(run('POST', HOSTILE, 'ws')).toBe(true);
  });

  it.each(['GET', 'HEAD', 'OPTIONS', 'get'])('passes the safe method %s even with hostile signals', (method) => {
    expect(run(method, HOSTILE)).toBe(true);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'PROPFIND', 'SEARCH'])(
    'decides every other method: %s from a same-site sibling is refused',
    (method) => refuses(method, SIBLING),
  );

  it('writes one FORK_ORIGIN_CHECK_REFUSED line per refusal, and none for an allowed or safe request', () => {
    resetOriginCheckLogForTests();
    const warn = jest.spyOn(originCheckLogSink, 'warn').mockImplementation(() => undefined);
    try {
      refuses('POST', SIBLING);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toBe(
        'FORK_ORIGIN_CHECK_REFUSED {"surface":"http","method":"POST","secFetchSite":"same-site","origin":"present","referer":"absent"}',
      );
      expect(run('POST', { host: HOST, origin: APP_URL })).toBe(true);
      expect(run('GET', HOSTILE)).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('decides a request WITHOUT the session cookie (no cookie exemption: login CSRF on native credential routes)', () => {
    refuses('POST', { ...SIBLING });
  });

  it('decides a request with the cookie AND a bearer (no bearer exemption: jwt.strategy reads the cookie first)', () => {
    refuses('POST', { ...SIBLING, cookie: '__Host-authToken=t', authorization: 'Bearer x' });
  });

  it('refuses Origin: null with no Sec-Fetch-Site (a sandboxed frame or no-referrer form)', () => {
    refuses('POST', { host: HOST, origin: 'null', cookie: 'authToken=t' });
  });

  it('allows a request with no browser signal (the relay, the service bridge, smokes, Playwright API)', () => {
    expect(run('POST', { host: HOST, cookie: 'authToken=t' })).toBe(true);
  });

  it('allows a same-origin browser write', () => {
    expect(run('POST', { host: HOST, 'sec-fetch-site': 'same-origin', origin: APP_URL, cookie: 'authToken=t' })).toBe(true);
  });

  it('trusts APP_URL even when Host differs (the dev proxy keeps its own Host)', () => {
    expect(run('POST', { host: 'localhost:5173', 'sec-fetch-site': 'same-origin', origin: APP_URL })).toBe(true);
  });

  it('trusts nothing else: a cross-site Origin that is not APP_URL is refused even if its host matches Host', () => {
    refuses('POST', { host: HOST, 'sec-fetch-site': 'cross-site', origin: APP_URL.replace('https:', 'http:') });
  });

  it('reads the raw Host header, never X-Forwarded-Host', () => {
    refuses('POST', { host: HOST, 'x-forwarded-host': 'evil.example', origin: 'https://evil.example' });
  });

  it('allows APP_URL as a cross-site trusted origin (the table: a trusted frontend)', () => {
    expect(run('POST', { host: 'other.example', 'sec-fetch-site': 'cross-site', origin: APP_URL })).toBe(true);
  });
});
