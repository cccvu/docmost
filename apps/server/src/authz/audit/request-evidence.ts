import type { IncomingMessage } from 'node:http';
import type { AuditClientEvidence } from './platform-audit.client';

/**
 * CCC audit integration — NOT upstream Docmost code (wiki-v2 #320/#467).
 *
 * Build the raw transport evidence `{ socketPeer, forwardedFor }` for a request from the UNTOUCHED node
 * request, for the platform to resolve the client address itself. This is the ONE source of truth shared by
 * the domain-event forwarder (`PlatformAuditService`) and the per-request `/api` access interceptor
 * (`ApiAccessAuditService`), so both produce identical, #320-clean rows.
 *
 * Why the raw request and not Docmost's `request.ip`: at middleware time `request.ip` is Fastify's
 * `trustProxy: true` result — the LEFTMOST `X-Forwarded-For` token, which a client picks. The socket peer is
 * the real hop-0 address the platform can trust.
 *
 * Together-or-neither: the platform treats a supplied `clientEvidence` as AUTHORITATIVE and records a
 * refusal when it cannot resolve a peer, so sending `forwardedFor` alone would mislabel a torn-down socket
 * as a forgery attempt. With no peer we return `undefined` and let the platform fall back to the legacy field.
 */
export function buildClientEvidenceFromReq(
  req: IncomingMessage | undefined,
): AuditClientEvidence | undefined {
  const socketPeer = req?.socket?.remoteAddress;
  if (!socketPeer) return undefined;
  const raw = req?.headers?.['x-forwarded-for'];
  // Typed `string | string[]`: Node comma-joins repeated header lines, so the array branch is unreachable
  // in practice — narrowed, not cast away.
  const forwardedFor = Array.isArray(raw) ? raw.join(', ') : raw;
  return forwardedFor ? { socketPeer, forwardedFor } : { socketPeer };
}
