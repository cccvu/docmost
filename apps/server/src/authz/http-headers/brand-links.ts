import { Logger } from '@nestjs/common';
import type { AuthzMode } from '../mode/authz-mode';

/**
 * CCC static brand links (wiki-v2 #905). NOT upstream Docmost code.
 *
 * The SPA's `index.html` links neutral defaults (`/icons/*`, `/manifest.json`), and the runtime brand loader
 * (`apps/client/src/features/brand/brand-config.ts`) points those links at the platform's `/brand` bundle only
 * after JavaScript runs. Anything that reads the site icon without running the SPA (Safari's tab and address bar,
 * password managers, the OS passkey picker, link unfurlers, public share pages) therefore saw the defaults.
 *
 * In remote mode the platform owns `/brand` on this origin (as it owns `/auth` and `/bff`), so at boot the server
 * rewrites the static hrefs to the same `/brand/*` URLs the runtime loader sets. The rewrite is an exact match on
 * each upstream `<link>` (rel, sizes and href): all of them or none. If upstream's `index.html` changes shape, the
 * HTML is served unchanged (the runtime loader still swaps the links after boot), the miss is logged, and
 * `brand-links.spec.ts`, which runs this on the real `apps/client/index.html`, goes red.
 *
 * Native (standalone) mode has no platform and so no `/brand`: the HTML is left alone there.
 * No brand string or artwork lives here: only the generic `/brand/` paths the platform's bundle serves
 * (`services/platform/test/brand-links-parity.spec.ts` pins every target to a file in that bundle).
 */
export interface BrandLinkRewrite {
  /** The `rel` attribute of the static `<link>`. */
  readonly rel: string;
  /** The `sizes` attribute, when the static link carries one. */
  readonly sizes?: string;
  /** The neutral href upstream's `index.html` links. */
  readonly from: string;
  /** The `/brand/*` href the runtime loader sets (brand-config.ts `applyBrandDocument`). */
  readonly to: string;
}

export const BRAND_LINK_REWRITES: readonly BrandLinkRewrite[] = [
  {
    rel: 'icon',
    sizes: '32x32',
    from: '/icons/favicon-32x32.png',
    to: '/brand/favicon-32x32.png',
  },
  {
    rel: 'icon',
    sizes: '16x16',
    from: '/icons/favicon-16x16.png',
    to: '/brand/favicon-16x16.png',
  },
  {
    rel: 'apple-touch-icon',
    from: '/icons/apple-touch-icon.png',
    to: '/brand/apple-touch-icon.png',
  },
  { rel: 'manifest', from: '/manifest.json', to: '/brand/site.webmanifest' },
];

export interface BrandLinksResult {
  readonly html: string;
  /** The rewrites that did not match exactly one `<link>` (empty when every link was rewritten). */
  readonly missing: readonly BrandLinkRewrite[];
}

const LINK_TAG = /<link\b[^>]*>/gi;

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag);
  return m ? m[1] : undefined;
}

function matches(tag: string, rewrite: BrandLinkRewrite): boolean {
  return (
    attr(tag, 'rel') === rewrite.rel &&
    attr(tag, 'sizes') === rewrite.sizes &&
    attr(tag, 'href') === rewrite.from
  );
}

/**
 * Pure: rewrite every static brand link, or none. Each rewrite must match exactly one `<link>` tag; when any of them
 * matches zero or several, the input is returned unchanged with the misses listed.
 */
export function brandStaticLinks(html: string): BrandLinksResult {
  const tags = html.match(LINK_TAG) ?? [];
  const missing = BRAND_LINK_REWRITES.filter(
    (r) => tags.filter((t) => matches(t, r)).length !== 1,
  );
  if (missing.length > 0) return { html, missing };
  const out = html.replace(LINK_TAG, (tag) => {
    const rewrite = BRAND_LINK_REWRITES.find((r) => matches(tag, r));
    return rewrite
      ? tag.replace(`href="${rewrite.from}"`, `href="${rewrite.to}"`)
      : tag;
  });
  return { html: out, missing: [] };
}

const logger = new Logger('BrandLinks');

/**
 * The seam call (`integrations/static/static.module.ts`, UPSTREAM_MODIFICATIONS.md #86): in remote mode, point the
 * static icon, apple-touch and manifest links at the platform's `/brand` bundle; otherwise return the HTML as is.
 */
export function applyBrandLinks(html: string, mode: AuthzMode): string {
  if (mode !== 'remote') return html;
  const { html: out, missing } = brandStaticLinks(html);
  if (missing.length > 0) {
    logger.warn(
      `BRAND_LINKS_UNMATCHED: index.html served with its neutral links; no exact <link> for ${missing
        .map(
          (r) =>
            `rel=${r.rel}${r.sizes ? ` sizes=${r.sizes}` : ''} href=${r.from}`,
        )
        .join('; ')} (did upstream's index.html change?)`,
    );
  }
  return out;
}
