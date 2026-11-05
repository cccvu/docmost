// Self-hosted typefaces (#409). These replace the render-blocking fonts.googleapis.com stylesheet: Vite
// bundles the @font-face rules into the app CSS and emits the .woff2 files under the content-hashed
// /assets/ (same-origin, `immutable`, no third-party request or preconnect). Both packages declare
// `font-display: swap`, so text paints in the fallback stack and never waits on a font.
//
// Inter is the UI/body/headings face (variable, one file per unicode-range subset; the browser fetches
// only the subsets a page uses). Roboto medium is loaded for one element only — the brand lockup's
// college line (brand-logo.module.css), whose single-story 'g' matches the college site's typeface.
import "@fontsource-variable/inter/wght.css";
import "@fontsource/roboto/latin-500.css";
