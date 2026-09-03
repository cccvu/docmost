import { AUTHZ_MODE, isAuthzMode, resolveAuthzMode } from './authz-mode';

describe('resolveAuthzMode', () => {
  it('accepts exactly native/remote (case + whitespace tolerant)', () => {
    expect(resolveAuthzMode('native')).toBe('native');
    expect(resolveAuthzMode('remote')).toBe('remote');
    expect(resolveAuthzMode('  NATIVE ')).toBe('native');
    expect(resolveAuthzMode('Remote')).toBe('remote');
  });

  it('THROWS (refuses to boot) on missing/empty/invalid — never a silent default', () => {
    // A missing or dropped value must not silently pick a mode. In particular there is deliberately no
    // "URL present => remote, absent => native" heuristic (that would be a silent-downgrade vector).
    expect(() => resolveAuthzMode(undefined)).toThrow(/AUTHZ_MODE/);
    expect(() => resolveAuthzMode(null)).toThrow(/AUTHZ_MODE/);
    expect(() => resolveAuthzMode('')).toThrow(/AUTHZ_MODE/);
    expect(() => resolveAuthzMode('   ')).toThrow(/AUTHZ_MODE/);
    expect(() => resolveAuthzMode('allow-all')).toThrow();
    expect(() => resolveAuthzMode('platform')).toThrow();
    expect(() => resolveAuthzMode('NATIVE remote')).toThrow();
  });

  it('exposes a unique symbol token and a type guard', () => {
    expect(typeof AUTHZ_MODE).toBe('symbol');
    expect(isAuthzMode('native')).toBe(true);
    expect(isAuthzMode('remote')).toBe(true);
    expect(isAuthzMode('nope')).toBe(false);
    expect(isAuthzMode(undefined)).toBe(false);
  });
});
