import { EXPORT_ADMISSION } from '../../authz/request-controls/export-admission.interceptor';
import {
  EXPORT_EXISTS_GLOBAL,
  EXPORT_LIMIT_CEILINGS,
  EXPORT_LIMIT_DEFAULTS,
  ExportBuildTimeoutException,
  exportLimits,
  ExportTooLargeException,
} from './export-limits';

/** #716 M5 (and the build bounds): what one native export may hold. Fork-owned. */

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

describe('export limits (#716)', () => {
  it('M5: the content ceiling keeps the heap of every admitted export together under ~0.5 GiB', () => {
    // export-limits.ts: ~1.9 B of parsed JSON + ~1.9 B of HTML per text byte, held until the archive streams.
    expect(EXPORT_LIMIT_CEILINGS.contentBytes).toBe(16 * MiB);
    expect(EXPORT_LIMIT_CEILINGS.contentBytes * 3.8 * EXPORT_ADMISSION.global).toBeLessThanOrEqual(0.5 * GiB);
    expect(EXPORT_LIMIT_DEFAULTS.contentBytes).toBeLessThanOrEqual(EXPORT_LIMIT_CEILINGS.contentBytes);
  });

  it('M5: an env value is clamped to the ceiling, junk falls back to the default', () => {
    expect(exportLimits({ EXPORT_CONTENT_MAX_BYTES: '999999999' }).contentBytes).toBe(16 * MiB);
    expect(exportLimits({ EXPORT_CONTENT_MAX_BYTES: String(4 * MiB) }).contentBytes).toBe(4 * MiB);
    expect(exportLimits({ EXPORT_CONTENT_MAX_BYTES: 'lots' }).contentBytes).toBe(EXPORT_LIMIT_DEFAULTS.contentBytes);
    expect(exportLimits({}).contentBytes).toBe(12 * MiB);
  });

  it('the build deadline sits under the ALB idle timeout (60 s), and the HEAD cap under the S3 pool (50)', () => {
    expect(exportLimits({}).buildMs).toBe(45_000);
    expect(exportLimits({}).buildMs).toBeLessThan(60_000);
    expect(EXPORT_EXISTS_GLOBAL).toBe(16);
    expect(EXPORT_EXISTS_GLOBAL).toBeLessThan(50);
    expect(EXPORT_EXISTS_GLOBAL).toBeGreaterThanOrEqual(EXPORT_LIMIT_DEFAULTS.existsConcurrency);
  });

  it('a page past the worker’s bounds is 422 export_too_large reason page; only a Markdown export is told to try HTML', () => {
    const e = ExportTooLargeException.page('markdown');
    expect(e.getStatus()).toBe(422);
    expect(e.reason).toBe('page');
    expect(e.getResponse()).toMatchObject({ code: 'export_too_large', message: expect.stringMatching(/as HTML.*smaller page/) });
    for (const html of [ExportTooLargeException.page('html'), ExportTooLargeException.page()]) {
      expect(html.getResponse()).toMatchObject({ code: 'export_too_large', message: expect.stringMatching(/smaller pages/) });
      expect((html.getResponse() as { message: string }).message).not.toMatch(/HTML/);
    }
  });

  it('the build timeout is a 503 export_timeout that names seconds, never "1 minutes"', () => {
    const e = new ExportBuildTimeoutException(45_000);
    expect(e.getStatus()).toBe(503);
    expect(e.getResponse()).toMatchObject({ code: 'export_timeout', message: expect.stringContaining('45 seconds') });
  });
});
