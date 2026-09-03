// CCC: the collapsed-sidebar mode decision, extracted from global-app-shell.tsx as
// a PURE function so it can be unit-tested (sidebar-collapse.test.ts). The wiki's
// Settings sidebar used to VANISH when the sidebar was minimized; this is the logic
// that fixes it, so it carries a regression guard against a silent revert.
//
// When the desktop sidebar toggle is off, EVERY navbar sidebar (home, settings,
// the space page-tree, AI chat) collapses to a 52px icon rail — none hide. This is
// deliberate (#1/#2): Mantine's "hide" slides the whole navbar off-screen
// (translateX) and jumps content to full width, so collapsing the space/AI
// sidebars used to read as "some sidebars vanish and slide" while home/settings
// merely shrank. Railing every sidebar makes collapse consistent and non-sliding;
// content sections that can't reduce to a single icon (the page tree, chat history)
// are hidden within the rail via each sidebar's `railHidden` CSS.
// `railsWhenCollapsed` is the single source of truth for both the navbar width and
// `collapsed.desktop`.

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
  // Every navbar sidebar rails when collapsed — home, settings, the space
  // page-tree, and AI chat alike — so none slide off-screen (#1/#2). A route
  // with no navbar sidebar simply never rails.
  const railsWhenCollapsed =
    showGlobalSidebar ||
    routes.isSettingsRoute ||
    routes.isSpaceRoute ||
    routes.isAiRoute;
  const isRail = railsWhenCollapsed && !desktopOpened;
  return { showGlobalSidebar, railsWhenCollapsed, isRail };
}
