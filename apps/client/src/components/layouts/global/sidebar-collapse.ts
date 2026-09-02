// CCC: the collapsed-sidebar mode decision, extracted from global-app-shell.tsx as
// a PURE function so it can be unit-tested (sidebar-collapse.test.ts). The wiki's
// Settings sidebar used to VANISH when the sidebar was minimized; this is the logic
// that fixes it, so it carries a regression guard against a silent revert.
//
// When the desktop sidebar toggle is off, NAVIGATION sidebars (home, settings)
// collapse to a 52px icon rail instead of hiding; CONTENT sidebars (the space
// page-tree, AI chat) keep the upstream show/hide behavior — a full-width reading
// view, since a tree/chat list has no meaningful icon rail. `railsWhenCollapsed` is
// the single source of truth for both the navbar width and `collapsed.desktop`.

export interface SidebarRouteFlags {
  isSpaceRoute: boolean;
  isSettingsRoute: boolean;
  isAiRoute: boolean;
}

export interface SidebarCollapseState {
  /** The home/global sidebar renders on this route (not space/settings/AI). */
  showGlobalSidebar: boolean;
  /** This route's sidebar rails (vs hides) when the desktop toggle is off. */
  railsWhenCollapsed: boolean;
  /** This route is currently showing its 52px icon rail. */
  isRail: boolean;
}

export function getSidebarCollapseState(
  routes: SidebarRouteFlags,
  desktopOpened: boolean,
): SidebarCollapseState {
  const showGlobalSidebar =
    !routes.isSpaceRoute && !routes.isSettingsRoute && !routes.isAiRoute;
  // Navigation sidebars (home, settings) rail; content sidebars (space, AI) hide.
  const railsWhenCollapsed = showGlobalSidebar || routes.isSettingsRoute;
  const isRail = railsWhenCollapsed && !desktopOpened;
  return { showGlobalSidebar, railsWhenCollapsed, isRail };
}
