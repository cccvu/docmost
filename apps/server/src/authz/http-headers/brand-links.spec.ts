import { Logger } from '@nestjs/common';
import { readFileSync, readdirSync } from 'node:fs';
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

const SERVER_SRC = join(__dirname, '..', '..');
const CLIENT_DIR = join(__dirname, '..', '..', '..', '..', 'client');

/** A source file with every whitespace run removed and prettier's trailing commas dropped, for seam pins. */
function squash(path: string): string {
  return readFileSync(path, 'utf8').replace(/\s+/g, '').replace(/,\)/g, ')');
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

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
    // #915: the matcher is as strict as the replace (no spaces around `=`, lower-case name), so a spelling the
    // replace would not rewrite counts as a miss instead of a silent no-op.
    [
      'an attribute is spaced around =',
      (h: string) =>
        h.replace(
          'href="/icons/favicon-32x32.png"',
          'href = "/icons/favicon-32x32.png"',
        ),
    ],
    [
      'an attribute name is upper case',
      (h: string) =>
        h.replace(
          'href="/icons/apple-touch-icon.png"',
          'HREF="/icons/apple-touch-icon.png"',
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

  // The JSON copy's basename must differ from `brand-links`: jest resolves `./brand-links` to a `.json` sibling
  // before the `.ts` module (moduleFileExtensions js, json, ts), which would shadow it in every spec.
  it('the table is the one the platform parity spec reads: brand-link-rewrites.json deep-equals BRAND_LINK_REWRITES (#915)', () => {
    expect(BRAND_LINK_REWRITES).toEqual(
      JSON.parse(
        readFileSync(join(__dirname, 'brand-link-rewrites.json'), 'utf8'),
      ),
    );
  });
});

/**
 * #915: the seams that carry the rewrite to the wire. These are upstream-owned files, read as text (whitespace
 * removed), because a unit test of the pure function stays green when a merge drops or doubles the call.
 */
describe('brand static links: seam pins (#915)', () => {
  it('static.module.ts calls applyBrandLinks exactly once, and its result is what it writes to index.html (§86)', () => {
    const src = squash(
      join(SERVER_SRC, 'integrations', 'static', 'static.module.ts'),
    );
    expect(count(src, 'applyBrandLinks(')).toBe(1);
    expect(src).toContain(
      'consttransformedHtml=applyBrandLinks(html.replace(windowVar,windowScriptContent),this.authzMode);',
    );
    expect(count(src, 'writeFileSync(indexFilePath,')).toBe(1);
    expect(src).toContain('fs.writeFileSync(indexFilePath,transformedHtml);');
  });

  it('share-seo.controller.ts serves the rewritten index.html, never the template', () => {
    const src = squash(
      join(SERVER_SRC, 'core', 'share', 'share-seo.controller.ts'),
    );
    expect(src).toContain(
      "constindexFilePath=join(clientDistPath,'index.html');",
    );
    expect(src).toContain("fs.readFileSync(indexFilePath,'utf8')");
    expect(src).not.toContain('index-template');
  });

  it('the Vite dev proxy answers every rewritten href with its /brand target (§11)', () => {
    const lines = readFileSync(
      join(CLIENT_DIR, 'vite.config.ts'),
      'utf8',
    ).split('\n');
    // Proxy keys are the `"<pattern>": {` lines; a key's block runs to the next key.
    const keyAt = lines
      .map((line, i) => ({ i, m: /^\s*"(.+)": \{$/.exec(line) }))
      .filter((k) => k.m !== null);
    const regexKeys = keyAt.filter((k) => k.m![1].startsWith('^/'));
    expect(regexKeys.length).toBeGreaterThanOrEqual(2); // anti-vacuity
    for (const r of BRAND_LINK_REWRITES) {
      const hits = regexKeys.filter((k) =>
        new RegExp(k.m![1].replace(/\\\\/g, '\\')).test(r.from),
      );
      expect({ from: r.from, keys: hits.length }).toEqual({
        from: r.from,
        keys: 1,
      });
      const next = keyAt.find((k) => k.i > hits[0].i);
      const block = lines
        .slice(hits[0].i, next ? next.i : undefined)
        .join('')
        .replace(/\s+/g, '');
      const rewrite =
        /rewrite:\(path\)=>path\.replace\(\/(.+?)\/,"([^"]*)"\)/.exec(block);
      expect(rewrite).not.toBeNull();
      expect(r.from.replace(new RegExp(rewrite![1]), rewrite![2])).toBe(r.to);
    }
  });

  it('transactional mail renders no Docmost footer: MailFooter stays deleted (§252)', () => {
    const dir = join(SERVER_SRC, 'integrations', 'transactional');
    const partials = readFileSync(
      join(dir, 'partials', 'partials.tsx'),
      'utf8',
    );
    expect(partials).not.toContain('MailFooter');
    expect(partials).not.toContain('All Rights Reserved');
    expect(partials).not.toContain('Docmost');
    expect(squash(join(dir, 'partials', 'partials.tsx'))).toContain(
      '<Bodystyle={main}><MailHeader/><Containerstyle={container}>{children}</Container></Body>',
    );
    for (const entry of readdirSync(dir, { recursive: true }) as string[]) {
      if (!/\.tsx?$/.test(entry)) continue;
      expect({
        entry,
        src: readFileSync(join(dir, entry), 'utf8').includes('MailFooter'),
      }).toEqual({
        entry,
        src: false,
      });
    }
  });
});
