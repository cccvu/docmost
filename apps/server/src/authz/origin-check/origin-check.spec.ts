import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { originCheckAllows, signalsFromHeaders } from './origin-check';

/**
 * wiki-v2 #655: the shared origin-check golden vectors, through the fork's port of the platform decision.
 *
 * origin-check-vectors.json is byte-identical to the platform's services/platform/test/fixtures copy (the super repo's
 * origin-check-vectors.spec.ts asserts it under PLATFORM_REQUIRE_FORK=1), so both copies of the decision answer the
 * same table. A vector's `signals` are the raw header values: an omitted key is an absent header, an array is a
 * non-string value. `rule` names the branch of the decision table the vector exercises.
 */
interface Vector {
  name: string;
  rule: string;
  signals: { secFetchSite?: unknown; origin?: unknown; referer?: unknown; host?: unknown };
  trusted: string[];
  allow: boolean;
}

const RULES = ['shape', 'origin-ours', 'referer-ours', 'cross-or-same-site', 'same-origin-or-none', 'no-site'];
const vectors = JSON.parse(readFileSync(join(__dirname, 'origin-check-vectors.json'), 'utf8')) as Vector[];

describe('origin-check golden vectors, shared with the platform (#655)', () => {
  describe('the table itself', () => {
    it('is well-formed: known keys, unique names, a known rule, a boolean outcome', () => {
      const names = new Set<string>();
      for (const v of vectors) {
        expect(Object.keys(v).sort()).toEqual(['allow', 'name', 'rule', 'signals', 'trusted']);
        expect(Object.keys(v.signals).filter((k) => !['secFetchSite', 'origin', 'referer', 'host'].includes(k))).toEqual([]);
        expect(names.has(v.name)).toBe(false);
        names.add(v.name);
        expect(RULES).toContain(v.rule);
        expect(typeof v.allow).toBe('boolean');
      }
    });

    it('is meaningful (anti-vacuity): enough vectors, both outcomes, every rule branch', () => {
      expect(vectors.length).toBeGreaterThanOrEqual(25);
      expect(vectors.filter((v) => v.allow).length).toBeGreaterThanOrEqual(8);
      expect(vectors.filter((v) => !v.allow).length).toBeGreaterThanOrEqual(8);
      for (const rule of RULES) expect(vectors.filter((v) => v.rule === rule).length).toBeGreaterThanOrEqual(2);
      // The cases each named mutation would get wrong are present.
      expect(vectors.some((v) => v.signals.origin === 'null' && v.signals.secFetchSite === undefined && !v.allow)).toBe(true);
      expect(vectors.some((v) => Array.isArray(v.signals.origin) && !v.allow)).toBe(true);
      expect(vectors.some((v) => v.rule === 'referer-ours' && !v.allow)).toBe(true);
      expect(vectors.some((v) => v.signals.secFetchSite === 'cross-site' && v.allow)).toBe(true);
      expect(vectors.some((v) => Object.keys(v.signals).length === 1 && v.signals.host !== undefined && v.allow)).toBe(true);
    });

    it('names only reserved example hosts (the fork is public: no institution name may enter it)', () => {
      const hosts = new Set<string>();
      for (const v of vectors) {
        for (const value of [v.signals.origin, v.signals.referer, ...v.trusted].flat()) {
          if (typeof value !== 'string') continue;
          try {
            const { hostname } = new URL(value);
            if (hostname) hosts.add(hostname);
          } catch {
            /* malformed on purpose */
          }
        }
        for (const h of [v.signals.host].flat()) if (typeof h === 'string') hosts.add(h.replace(/:\d+$/, ''));
      }
      for (const h of hosts) expect(h).toMatch(/^(localhost|([a-z0-9-]+\.)*example(\.(com|edu))?)$/);
    });
  });

  it.each(vectors.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    expect(originCheckAllows({ secFetchSite: undefined, origin: undefined, referer: undefined, host: undefined, ...v.signals }, v.trusted)).toBe(v.allow);
  });

  it('reads the four signals from raw header names, and nothing else (never X-Forwarded-Host)', () => {
    expect(
      signalsFromHeaders({
        'sec-fetch-site': 'same-origin',
        origin: 'https://wiki.example.com',
        referer: 'https://wiki.example.com/x',
        host: 'wiki.example.com',
        'x-forwarded-host': 'evil.example',
      }),
    ).toEqual({
      secFetchSite: 'same-origin',
      origin: 'https://wiki.example.com',
      referer: 'https://wiki.example.com/x',
      host: 'wiki.example.com',
    });
  });
});
