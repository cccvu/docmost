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

/** Expanded navigation-sidebar width (px) — a FIXED width shared by every sidebar
 *  (home / space page-tree / settings / AI). Not resizable: all views read identically. */
export const SIDEBAR_WIDTH = 260;

/** Right-hand aside (comments / TOC / details) width (px). */
export const ASIDE_WIDTH = 350;

/** App-shell surface color for the header + navbar/aside. A native CSS `light-dark()`
 *  expression so the shell tracks the color scheme. The fork's CSS module
 *  (app-shell.module.css) inlines this same value; the standalone console imports this
 *  token. KEEP IN SYNC across both layout-tokens files (drift guard) and that CSS. */
export const SHELL_BG = "light-dark(#f6f7f9, var(--mantine-color-dark-8))";

/** Mantine AppShell navbar/aside breakpoint — below this the navbar is a mobile overlay. */
export const NAVBAR_BREAKPOINT = "sm";
