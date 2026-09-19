/**
 * #390 — the two operator alarm tokens for the collab persistence guard, emitted from the fork's authz/ tree.
 *
 * They live HERE (not inline in the upstream persistence extension) for two reasons: (1) the tokens are
 * cross-service contract with `infra/terraform/monitoring.tf`'s CloudWatch metric-filter alarms, so they are
 * fork-owned policy code; (2) `scripts/check-infra-config.mjs` §14 only scans the fork's `authz/` and
 * `service-bridge/` subtrees for a filter's emitter, so a token emitted from `collaboration/` would fail-close
 * the deploy (14b/14g). Keep these in sync with `LOG_TOKENS.fork` in that script.
 *
 * The logger is duck-typed (NestJS `Logger`) so this module pulls no framework import and stays trivially
 * testable. Each token is the FIRST word of the line — the metric filters match the bare token.
 */
type LoggerLike = {
  warn: (message: string) => void;
  error: (message: string, trace?: unknown) => void;
};

/** A stale resident Y.Doc was reconciled against out-of-band row content before a store (the #390 recovery). */
export function logStaleReconcile(logger: LoggerLike, detail: string): void {
  logger.warn(`COLLAB_STALE_RECONCILE ${detail}`);
}

/** A page store failed to persist; the settle will fail a guarded write closed rather than report success. */
export function logStoreFailure(
  logger: LoggerLike,
  pageId: string,
  err: unknown,
): void {
  logger.error(`COLLAB_STORE_FAILED failed to persist page ${pageId}`, err);
}

/**
 * A best-effort POST-STORE side effect failed AFTER the page row committed (#345). The content IS durable;
 * only a derived-data / notification effect (broadcast, transclusion sync, contributors, mention/AI/history
 * enqueue) did not complete. `onStoreDocument` still resolves — re-throwing would leave the store resident in
 * Hocuspocus's debouncer and wedge all future persistence for the document — so this is otherwise SILENT.
 * Emitting the token gives it a CloudWatch alarm (monitoring.tf), mirroring COLLAB_STORE_FAILED, so a
 * systematic post-store failure (a wedged Redis/BullMQ, a broken queue) pages someone instead of only landing
 * in the logs. Content-safe, so distinct from COLLAB_STORE_FAILED (which is fail-closed data-durability).
 */
export function logPostStoreFailure(
  logger: LoggerLike,
  sideEffect: string,
  pageId: string,
  err: unknown,
): void {
  logger.error(
    `COLLAB_POST_STORE_FAILED post-store side effect '${sideEffect}' failed for page ${pageId} (content already persisted)`,
    err,
  );
}
