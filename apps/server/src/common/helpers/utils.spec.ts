import { parseRedisUrl, sanitizeFileName } from './utils';

describe('sanitizeFileName', () => {
  describe('default (storage-safe)', () => {
    it.each([
      ['simple.txt', 'simple.txt'],
      ['my page.md', 'my_page.md'],
      ['hash#tag.md', 'hash_tag.md'],
      ['Q4 25% growth.pdf', 'Q4_25%_growth.pdf'],
      ['résumé.docx', 'résumé.docx'],
    ])('keeps legitimate input "%s" → "%s"', (input, expected) => {
      expect(sanitizeFileName(input)).toBe(expected);
    });

    it.each([
      ['file<script>.svg', 'filescript.svg'],
      ['file:name?.pdf', 'filename.pdf'],
      ['evil*pipe|file.txt', 'evilpipefile.txt'],
      ['../traversal.svg', '..traversal.svg'],
      ['..\\windows.svg', '..windows.svg'],
      ['null\u0000byte.txt', 'nullbyte.txt'],
    ])('strips illegal chars from "%s" → "%s"', (input, expected) => {
      expect(sanitizeFileName(input)).toBe(expected);
    });

    it.each([
      ['..%2Fevil.svg', '..evil.svg'],
      ['..%5Cevil.svg', '..evil.svg'],
      ['..%2Ffiles%2Fa%2Fevil.svg', '..filesaevil.svg'],
      ['file%3Aname.txt', 'filename.txt'],
      ['file%00.txt', 'file.txt'],
    ])(
      'decodes percent-encoded path chars before sanitizing "%s" → "%s"',
      (input, expected) => {
        expect(sanitizeFileName(input)).toBe(expected);
      },
    );

    it('handles double-encoded payloads after one decode pass', () => {
      // %252F decodes once to %2F (left as literal — not a path separator
      // after only one decode). Fastify already does one decode at the route
      // layer, so by the time this helper sees it, %252F has become %2F,
      // which we then decode to "/" and strip.
      expect(sanitizeFileName('..%252Fevil.svg')).toBe('..%2Fevil.svg');
      expect(sanitizeFileName('..%2Fevil.svg')).toBe('..evil.svg');
    });

    it('leaves malformed percent sequences alone (not decodable)', () => {
      // %ZZ is not a valid percent encoding — the regex won't match it.
      expect(sanitizeFileName('100%ZZ.txt')).toBe('100%ZZ.txt');
      // standalone % with no hex pair after it
      expect(sanitizeFileName('100% off.txt')).toBe('100%_off.txt');
    });

    it('returns empty for inputs that are entirely illegal', () => {
      expect(sanitizeFileName('..')).toBe('');
      expect(sanitizeFileName('...')).toBe('');
      expect(sanitizeFileName('CON.txt')).toBe('');
    });

    it('caps output at 255 bytes (handled by sanitize-filename internally)', () => {
      const long = 'a'.repeat(500) + '.txt';
      expect(sanitizeFileName(long).length).toBeLessThanOrEqual(255);
    });
  });

  describe('preserveSpaces option', () => {
    it('keeps spaces and # untouched', () => {
      expect(
        sanitizeFileName('My Page #1.md', { preserveSpaces: true }),
      ).toBe('My Page #1.md');
    });

    it('still strips illegal chars and decodes percent-encoding', () => {
      expect(
        sanitizeFileName('../my page.svg', { preserveSpaces: true }),
      ).toBe('..my page.svg');
      expect(
        sanitizeFileName('..%2Fmy page.svg', { preserveSpaces: true }),
      ).toBe('..my page.svg');
    });

    it('preserves accented and unicode chars', () => {
      expect(
        sanitizeFileName('Café & résumé.pdf', { preserveSpaces: true }),
      ).toBe('Café & résumé.pdf');
    });
  });
});

// #267: parseRedisUrl is the single seam the four pooled Redis clients (BullMQ, throttler, general ioredis,
// collab RedisSync) build their ioredis options from. It must surface `tls` for a rediss:// URL, or those
// clients talk plaintext against a transit-encryption-required ElastiCache endpoint and fail at connect.
describe('parseRedisUrl — #267 TLS + AUTH', () => {
  it('emits tls ({}) for a rediss:// URL and extracts the AUTH token as password', () => {
    const cfg = parseRedisUrl('rediss://:s3cr3t-token@my-rg.abc.ng.0001.use1.cache.amazonaws.com:6379');
    expect(cfg.tls).toEqual({});
    expect(cfg.password).toBe('s3cr3t-token');
    expect(cfg.host).toBe('my-rg.abc.ng.0001.use1.cache.amazonaws.com');
    expect(cfg.port).toBe(6379);
  });

  it('leaves tls undefined for a plaintext redis:// URL (no accidental TLS)', () => {
    const cfg = parseRedisUrl('redis://localhost:6379');
    expect(cfg.tls).toBeUndefined();
    expect(cfg.host).toBe('localhost');
  });

  it('still parses db and family alongside tls (no regression to the existing fields)', () => {
    const cfg = parseRedisUrl('rediss://:tok@host:6380/3?family=6');
    expect(cfg.tls).toEqual({});
    expect(cfg.port).toBe(6380);
    expect(cfg.db).toBe(3);
    expect(cfg.family).toBe(6);
  });
});
