import { Logger } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BRAND_LINK_REWRITES,
  applyBrandLinks,
  brandStaticLinks,
} from './brand-links';

/**
 * CCC (wiki-v2 #905). The boot rewrite runs on the REAL `apps/client/index.html` (the source Vite copies into
 * `client/dist/index.html` with these `<link>` tags untouched), so an upstream change to the shell's icon or manifest
 * links reds here instead of silently serving the neutral icons in prod.
 */
const INDEX_HTML = readFileSync(
  join(__dirname, '..', '..', '..', '..', 'client', 'index.html'),
  'utf8',
);

/** Every `<link>` tag's rel/sizes/href, in document order. */
function links(
  html: string,
): Array<{ rel?: string; sizes?: string; href?: string }> {
  return (html.match(/<link\b[^>]*>/gi) ?? []).map((tag) => {
    const get = (n: string) => new RegExp(`\\s${n}="([^"]*)"`).exec(tag)?.[1];
    return { rel: get('rel'), sizes: get('sizes'), href: get('href') };
  });
}

describe('brand static links (#905)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('covers the icon (32, 16), apple-touch and manifest links, all under /brand/ (anti-vacuity)', () => {
    expect(BRAND_LINK_REWRITES).toHaveLength(4);
    expect(BRAND_LINK_REWRITES.map((r) => r.rel).sort()).toEqual([
      'apple-touch-icon',
      'icon',
      'icon',
      'manifest',
    ]);
    for (const r of BRAND_LINK_REWRITES)
      expect(r.to).toMatch(/^\/brand\/[a-z0-9.-]+$/);
  });

  it('rewrites every static icon, apple-touch and manifest href in the real index.html to /brand/*, and nothing else', () => {
    const { html, missing } = brandStaticLinks(INDEX_HTML);
    expect(missing).toEqual([]);
    expect(links(html)).toEqual([
      { rel: 'icon', sizes: '32x32', href: '/brand/favicon-32x32.png' },
      { rel: 'icon', sizes: '16x16', href: '/brand/favicon-16x16.png' },
      {
        rel: 'apple-touch-icon',
        sizes: undefined,
        href: '/brand/apple-touch-icon.png',
      },
      { rel: 'manifest', sizes: undefined, href: '/brand/site.webmanifest' },
    ]);
    // Only the four hrefs differ: put the neutral ones back and the documents are byte-identical.
    let restored = html;
    for (const r of BRAND_LINK_REWRITES)
      restored = restored.replace(`href="${r.to}"`, `href="${r.from}"`);
    expect(restored).toBe(INDEX_HTML);
    // The placeholders the boot config and share pages fill are untouched.
    expect(html).toContain('<!--window-config-->');
    expect(html).toContain('<!--meta-tags-->');
  });

  it('remote mode applies the rewrite; native (standalone, no platform) leaves the HTML byte-identical', () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    expect(applyBrandLinks(INDEX_HTML, 'remote')).toBe(
      brandStaticLinks(INDEX_HTML).html,
    );
    expect(applyBrandLinks(INDEX_HTML, 'remote')).not.toBe(INDEX_HTML);
    expect(applyBrandLinks(INDEX_HTML, 'native')).toBe(INDEX_HTML);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a link is missing',
      (h: string) => h.replace(/\s*<link rel="apple-touch-icon"[^>]*>/, ''),
    ],
    [
      'a href changed',
      (h: string) =>
        h.replace('/icons/favicon-16x16.png', '/icons/favicon-16.png'),
    ],
    [
      'a sizes attribute changed',
      (h: string) => h.replace('sizes="32x32"', 'sizes="any"'),
    ],
    [
      'a link is duplicated',
      (h: string) =>
        h.replace(
          '<link rel="manifest" href="/manifest.json" />',
          '<link rel="manifest" href="/manifest.json" /><link rel="manifest" href="/manifest.json" />',
        ),
    ],
  ])(
    'all or nothing: when %s, the HTML is served unchanged and the miss is logged',
    (_name, mutate) => {
      const shifted = mutate(INDEX_HTML);
      expect(shifted).not.toBe(INDEX_HTML); // the mutation applied
      const { html, missing } = brandStaticLinks(shifted);
      expect(missing).toHaveLength(1);
      expect(html).toBe(shifted);

      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      expect(applyBrandLinks(shifted, 'remote')).toBe(shifted);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/^BRAND_LINKS_UNMATCHED: /);
    },
  );

  it('matches the attribute exactly: a look-alike link elsewhere in the page is never rewritten', () => {
    const extra = INDEX_HTML.replace(
      '</head>',
      '<link rel="preload" href="/manifest.json" as="fetch" />\n  </head>',
    );
    const { html, missing } = brandStaticLinks(extra);
    expect(missing).toEqual([]);
    expect(html).toContain(
      '<link rel="preload" href="/manifest.json" as="fetch" />',
    );
  });
});
