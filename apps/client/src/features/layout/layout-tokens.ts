// CCC layout tokens (issue: UI consistency). The single source of truth for the
// app-shell dimensions that must read identically across every surface — the wiki
// shells here AND the standalone admin console (services/admin-ui). Before this,
// each shell hard-coded its own literals (console sidebar 220 vs wiki 300, a 52px
// rail described in comments as "60px", magic alignment offsets), which is exactly
// how the two apps drifted.
//
// The console is proprietary and must not import from this AGPL fork, and each app
// builds in isolation — so these values are DUPLICATED into
// `services/admin-ui/src/layout-tokens.ts` rather than shared, and a drift guard
// (`services/admin-ui/src/layout-sync.test.ts`) fails loudly if the two copies
// diverge. KEEP THE SHARED TOKENS IN SYNC with that file (same pattern as
// brand-sync.test.ts / theme.ts "KEEP IN SYNC").

/** App-shell header height (px). Raised 45→56 for the Vanderbilt/CCC lockup. */
export const HEADER_HEIGHT = 56;

/** Collapsed icon-rail width (px). Every navbar sidebar rails to this on collapse. */
export const RAIL_WIDTH = 52;

/** Expanded navigation-sidebar width (px) — home/settings, and the space page-tree default. */
export const SIDEBAR_WIDTH = 300;

/** Resize clamp for the space page-tree sidebar (px). */
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 600;

/** Right-hand aside (comments / TOC / details) width (px). */
export const ASIDE_WIDTH = 350;

/** Mantine AppShell navbar/aside breakpoint — below this the navbar is a mobile overlay. */
export const NAVBAR_BREAKPOINT = "sm";
