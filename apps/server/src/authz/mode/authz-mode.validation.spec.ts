import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { EnvironmentVariables } from '../../integrations/environment/environment.validation';

/**
 * Boot-validator coverage for the CCC AUTHZ_MODE seam (#85) — NOT upstream Docmost code.
 *
 * `validate()` in environment.validation.ts calls `process.exit(1)` on failure (correct at boot, untestable
 * in-process), so we drive the class-validator layer directly: a config that produces AUTHZ_MODE errors here
 * is a config that refuses to boot there. This pins the fail-closed cross-field rules — remote REQUIRES a URL
 * + a >=16-char secret, and the mode itself must be exactly native|remote — so a future edit can't silently
 * weaken them into a boot that denies-all or falls back to native.
 */
const BASE = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  APP_SECRET: 'x'.repeat(32),
};

const failedProps = (config: Record<string, unknown>): string[] =>
  validateSync(plainToInstance(EnvironmentVariables, config), {
    skipMissingProperties: false,
  }).map((e) => e.property);

describe('environment validation — AUTHZ_MODE (seam #85, fail-closed boot)', () => {
  it('accepts a valid native config (no AUTHZ errors)', () => {
    const props = failedProps({ ...BASE, AUTHZ_MODE: 'native' });
    expect(props).not.toContain('AUTHZ_MODE');
    expect(props).not.toContain('PLATFORM_AUTHZ_URL');
    expect(props).not.toContain('PLATFORM_AUTHZ_SERVICE_SECRET');
  });

  it('accepts a valid remote config (URL + >=16-char secret)', () => {
    const props = failedProps({
      ...BASE,
      AUTHZ_MODE: 'remote',
      PLATFORM_AUTHZ_URL: 'http://platform:4000',
      PLATFORM_AUTHZ_SERVICE_SECRET: 'x'.repeat(16),
    });
    expect(props).not.toContain('AUTHZ_MODE');
    expect(props).not.toContain('PLATFORM_AUTHZ_URL');
    expect(props).not.toContain('PLATFORM_AUTHZ_SERVICE_SECRET');
  });

  it('rejects a missing mode (required, no default)', () => {
    expect(failedProps({ ...BASE })).toContain('AUTHZ_MODE');
  });

  it('rejects an invalid mode (no "allow-all"/heuristic escape hatch)', () => {
    expect(failedProps({ ...BASE, AUTHZ_MODE: 'allow-all' })).toContain('AUTHZ_MODE');
  });

  it('rejects remote WITHOUT the authorization service URL', () => {
    const props = failedProps({
      ...BASE,
      AUTHZ_MODE: 'remote',
      PLATFORM_AUTHZ_SERVICE_SECRET: 'x'.repeat(16),
    });
    expect(props).toContain('PLATFORM_AUTHZ_URL');
  });

  it('rejects remote WITHOUT the service secret', () => {
    const props = failedProps({
      ...BASE,
      AUTHZ_MODE: 'remote',
      PLATFORM_AUTHZ_URL: 'http://platform:4000',
    });
    expect(props).toContain('PLATFORM_AUTHZ_SERVICE_SECRET');
  });

  it('rejects remote with a too-short (<16) service secret', () => {
    const props = failedProps({
      ...BASE,
      AUTHZ_MODE: 'remote',
      PLATFORM_AUTHZ_URL: 'http://platform:4000',
      PLATFORM_AUTHZ_SERVICE_SECRET: 'short',
    });
    expect(props).toContain('PLATFORM_AUTHZ_SERVICE_SECRET');
  });

  it('does NOT require the remote fields in native mode (cross-field gating is mode-scoped)', () => {
    const props = failedProps({ ...BASE, AUTHZ_MODE: 'native' });
    expect(props).toEqual([]);
  });
});
