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

/** App-shell header height (px). Raised 45→56 to give the brand lockup room. */
export const HEADER_HEIGHT = 56;

/** Collapsed icon-rail width (px). Every navbar sidebar rails to this on collapse. */
export const RAIL_WIDTH = 52;

/** Default navigation-sidebar width (px) — the starting width shared by every sidebar
 *  (home / space page-tree / settings / AI). The user can drag-resize from here; the chosen
 *  width is persisted and applied uniformly to every sidebar, so views still read identically
 *  to each other at whatever width is chosen (a single global width, never per-view). */
export const SIDEBAR_WIDTH = 260;

/** Sidebar resize bounds (px). The persisted width is clamped to this range on read and
 *  write, so a corrupt or out-of-range stored value can never break the layout. */
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 600;

/** localStorage key holding the user's chosen sidebar width (px). Shared SAME-ORIGIN with
 *  the standalone admin console (services/admin-ui) so a resize survives navigation between
 *  the wiki and the console. The two apps must NOT import each other (AGPL boundary), so
 *  each reads/writes this same key independently. KEEP IN SYNC with the console
 *  layout-tokens.ts copy (drift guard, services/admin-ui/src/layout-sync.test.ts). */
export const SIDEBAR_WIDTH_STORAGE_KEY = "sidebarWidth";

/** Right-hand aside (comments / TOC / details) width (px). */
export const ASIDE_WIDTH = 350;

/** App-shell surface color for the header + navbar/aside. A native CSS `light-dark()`
 *  expression so the shell tracks the color scheme. The fork's CSS module
 *  (app-shell.module.css) inlines this same value; the standalone console imports this
 *  token. KEEP IN SYNC across both layout-tokens files (drift guard) and that CSS. */
export const SHELL_BG = "light-dark(#f6f7f9, var(--mantine-color-dark-8))";

/** Mantine AppShell navbar/aside breakpoint — below this the navbar is a mobile overlay. */
export const NAVBAR_BREAKPOINT = "sm";
