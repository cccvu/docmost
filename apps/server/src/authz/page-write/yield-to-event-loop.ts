/**
 * CCC integration — NOT upstream Docmost code (#716, #731, UPSTREAM_MODIFICATIONS.md §2 and #122).
 */

/**
 * Let other work (websocket frames, HTTP requests, database replies, health checks, timers) run between two heavy
 * synchronous steps: a full event-loop turn, INCLUDING an I/O poll.
 *
 * #731: two `setImmediate` hops, never one. A heavy step usually runs in a poll-phase callback (a pg or Redis reply, a
 * worker message, an HTTP request) or in its promise continuations. One `setImmediate` queued there runs in the SAME
 * loop iteration's check phase, before libuv polls again, so no I/O that arrived during the step is handled before
 * the next step: the two steps are one block to every other request. An immediate queued from the check phase runs
 * in the next iteration, after its poll (with immediates pending, that poll does not block). Pinned with real socket
 * I/O in `yield-to-event-loop.spec.ts`.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));
}
