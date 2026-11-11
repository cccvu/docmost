/**
 * CCC collab integration — NOT upstream Docmost code (#810, ADR 0036).
 *
 * Where the fork's trust in X-Forwarded-For comes from: the platform, which already owns and validates the trusted-proxy
 * list (`PLATFORM_TRUSTED_PROXIES`) and applies it to its own requests (the #320 precedent: the audit ingest lets the
 * platform decide client addresses too). It serves that list at `GET /authz/edge-trust` over the loopback channel the
 * fork's authz client already uses (`PLATFORM_AUTHZ_URL` and the `x-authz-service-secret` header), so there is one
 * trust source and no second copy in the docmost task definition to drift.
 *
 * Two states:
 * - `unknown`: not fetched yet (the platform still booting), not served (an older platform, the reference stub: 404),
 *   malformed, or the fork not in remote mode. Every key is `null`, so the per-address share is OFF: exactly the
 *   behaviour before #810 (the pool, the deadlines and the byte bounds still apply). It never guesses a key, so proxied
 *   users never collapse into the proxy's bucket. An attacker cannot cause it: the call is loopback plus the secret.
 * - `active`: the last good answer. A failed refresh keeps it.
 *
 * `start()` (CollabSocketBounds.onModuleInit) fetches at once without blocking the boot, retries with backoff
 * (TRUST_RETRY_MIN_MS doubling to TRUST_RETRY_MAX_MS) until it succeeds, then refreshes every TRUST_REFRESH_MS. Its
 * timers are unref'd and `stop()` (onModuleDestroy) ends them. Outside remote mode, or with no PLATFORM_AUTHZ_URL, it
 * never fetches and logs `unknown` once.
 *
 * Logged `COLLAB_SOCKET_LIMIT {"limit":"client_address_trust","state":…}` on every change of state, list size, xff or
 * failure reason (never per attempt, so a down platform is one line, not one every 30 s), and an error line when the
 * platform serves a malformed answer. The post-deploy check reads `{"state":"active","proxies":N}`.
 */
import { Logger } from '@nestjs/common';
import { isIP } from 'node:net';
import { sanitizeAuthzTimeoutMs } from '../http-authz.client';
import { collabClientKey, type ClientAddressRequest, type ClientKey, type EdgeTrust } from './client-address';
import type { SocketLimitLog } from './socket-limit-log';

/** First retry after a failed fetch; doubles each failure up to TRUST_RETRY_MAX_MS. */
export const TRUST_RETRY_MIN_MS = 1_000;
export const TRUST_RETRY_MAX_MS = 30_000;
/** Refresh once active: the list changes only with the platform's env, which a deploy replaces with this task. */
export const TRUST_REFRESH_MS = 5 * 60_000;
/** More entries than any front door could have: a longer list is malformed, not a topology. */
const MAX_TRUSTED_PROXIES = 64;
/** The platform's authz client default (http-authz.client.ts), the same bound on a hung platform. */
const DEFAULT_TIMEOUT_MS = 1500;

/** One fetch: the parsed JSON body, or why there is none (a bounded word: `http_<status>`, `timeout`, `transport`). */
export type EdgeTrustFetchResult = { body: unknown; reason?: undefined } | { body?: undefined; reason: string };
export type EdgeTrustFetch = () => Promise<EdgeTrustFetchResult>;

/**
 * The platform's edge-trust endpoint, or null (never fetched) outside remote mode or without PLATFORM_AUTHZ_URL. Same
 * base URL, header and timeout as HttpAuthzClient; a GET with no body and no request input.
 */
export function platformEdgeTrustFetch(mode: string | undefined, env: NodeJS.ProcessEnv = process.env): EdgeTrustFetch | null {
  const baseUrl = env.PLATFORM_AUTHZ_URL;
  if (mode !== 'remote' || !baseUrl) return null;
  const secret = env.PLATFORM_AUTHZ_SERVICE_SECRET ?? '';
  const timeoutMs = sanitizeAuthzTimeoutMs(env.PLATFORM_AUTHZ_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  return async () => {
    try {
      const res = await fetch(`${baseUrl}/authz/edge-trust`, {
        method: 'GET',
        headers: { 'x-authz-service-secret': secret },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return { reason: `http_${res.status}` };
      return { body: await res.json().catch(() => undefined) }; // a body that is not JSON is malformed
    } catch (e) {
      const name = (e as { name?: unknown } | null)?.name;
      return { reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'transport' };
    }
  };
}

/** `body` as an EdgeTrust, or null: `{ trustedProxies: <IP literal>[], xffTrusted: boolean }` (extra keys ignored). */
export function parseEdgeTrust(body: unknown): EdgeTrust | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const { trustedProxies, xffTrusted } = body as Record<string, unknown>;
  if (typeof xffTrusted !== 'boolean' || !Array.isArray(trustedProxies)) return null;
  if (trustedProxies.length > MAX_TRUSTED_PROXIES) return null;
  if (!trustedProxies.every((p) => typeof p === 'string' && isIP(p) !== 0)) return null;
  return Object.freeze({ trustedProxies: Object.freeze([...(trustedProxies as string[])]), xffTrusted });
}

export interface CollabClientTrustOptions {
  /** The platform's endpoint (platformEdgeTrustFetch); null keeps the trust unknown and never fetches. */
  fetchTrust?: EdgeTrustFetch | null;
  limitLog: SocketLimitLog;
  errorLog?: { error(message: string): void };
  retryMinMs?: number;
  retryMaxMs?: number;
  refreshMs?: number;
}

export type ClientTrustState = 'unknown' | 'active';

export class CollabClientTrust {
  private current: EdgeTrust | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private retryMs: number;
  private lastLogged = '';
  private readonly fetchTrust: EdgeTrustFetch | null;
  private readonly limitLog: SocketLimitLog;
  private readonly errorLog: { error(message: string): void };
  private readonly retryMinMs: number;
  private readonly retryMaxMs: number;
  private readonly refreshMs: number;

  constructor({
    fetchTrust = null,
    limitLog,
    errorLog = new Logger('CollabClientTrust'),
    retryMinMs = TRUST_RETRY_MIN_MS,
    retryMaxMs = TRUST_RETRY_MAX_MS,
    refreshMs = TRUST_REFRESH_MS,
  }: CollabClientTrustOptions) {
    this.fetchTrust = fetchTrust;
    this.limitLog = limitLog;
    this.errorLog = errorLog;
    this.retryMinMs = retryMinMs;
    this.retryMaxMs = retryMaxMs;
    this.refreshMs = refreshMs;
    this.retryMs = retryMinMs;
  }

  get state(): ClientTrustState {
    return this.current ? 'active' : 'unknown';
  }

  /** The last good answer, or null while unknown. */
  get trust(): EdgeTrust | null {
    return this.current;
  }

  /** The client key of a request, or null while the trust is unknown (the share is off: no key is ever guessed). */
  keyFor(req: ClientAddressRequest): ClientKey | null {
    return this.current ? collabClientKey(req, this.current) : null;
  }

  /** Begin fetching (non-blocking; idempotent). Without a fetch, logs `unknown` once and does nothing else. */
  start(): void {
    if (this.running) return;
    this.running = true;
    if (!this.fetchTrust) {
      this.note('unknown', { reason: 'not_configured' });
      return;
    }
    void this.attempt();
  }

  /** Stop every timer; an in-flight fetch schedules nothing once it settles. */
  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** One fetch, then the next one scheduled (specs drive it directly). */
  async attempt(): Promise<void> {
    if (!this.fetchTrust) return;
    const result = await this.fetchTrust().catch((): EdgeTrustFetchResult => ({ reason: 'transport' }));
    const parsed = result.reason === undefined ? parseEdgeTrust(result.body) : null;
    if (parsed) {
      this.current = parsed;
      this.retryMs = this.retryMinMs;
      this.note('active', { proxies: parsed.trustedProxies.length, xff: parsed.xffTrusted ? 'on' : 'off' });
      this.schedule(this.refreshMs);
      return;
    }
    const reason = result.reason ?? 'malformed';
    const logged = this.note(this.state, { reason, ...(this.current ? { proxies: this.current.trustedProxies.length } : {}) });
    if (logged && reason === 'malformed') {
      this.errorLog.error(`COLLAB_SOCKET_LIMIT ${JSON.stringify({ limit: 'client_address_trust', error: 'malformed', state: this.state })}`);
    }
    this.schedule(this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, this.retryMaxMs);
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.attempt();
    }, ms);
    this.timer.unref?.();
  }

  /** Log the state line only when it differs from the last one; true when it logged. */
  private note(state: ClientTrustState, fields: Record<string, string | number>): boolean {
    const line = JSON.stringify({ state, ...fields });
    if (line === this.lastLogged) return false;
    this.lastLogged = line;
    this.limitLog.log('client_address_trust', { state, ...fields });
    return true;
  }
}
