import { logStaleReconcile, logStoreFailure } from './collab-drift-log';

// #390: these two alarm tokens are wired to CloudWatch metric-filter alarms in infra/terraform/monitoring.tf
// and pinned by scripts/check-infra-config.mjs §14 (LOG_TOKENS.fork). The emitters MUST live under the fork's
// authz/ tree — that is the only fork subtree §14's emitter scan reads — so a rename here breaks BOTH the
// alarm and this test. Keep the tokens as the FIRST word of the log line (the metric filter matches the bare
// token) and in sync with LOG_TOKENS.fork.
describe('collab-drift-log (#390 alarm tokens)', () => {
  it('logStaleReconcile emits the COLLAB_STALE_RECONCILE token as a warning', () => {
    const logger = { warn: jest.fn(), error: jest.fn() };
    logStaleReconcile(logger, 'page-123 reason');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/^COLLAB_STALE_RECONCILE\b/);
    expect(logger.warn.mock.calls[0][0]).toContain('page-123');
  });

  it('logStoreFailure emits the COLLAB_STORE_FAILED token as an error and forwards the cause', () => {
    const logger = { warn: jest.fn(), error: jest.fn() };
    const err = new Error('db down');
    logStoreFailure(logger, 'page-456', err);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0]).toMatch(/^COLLAB_STORE_FAILED\b/);
    expect(logger.error.mock.calls[0][0]).toContain('page-456');
    expect(logger.error.mock.calls[0][1]).toBe(err);
  });
});
