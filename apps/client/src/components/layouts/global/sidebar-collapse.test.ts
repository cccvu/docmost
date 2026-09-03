import { describe, it, expect } from "vitest";
import { getSidebarCollapseState } from "./sidebar-collapse";

const HOME = { isSpaceRoute: false, isSettingsRoute: false, isAiRoute: false };
const SETTINGS = { isSpaceRoute: false, isSettingsRoute: true, isAiRoute: false };
const SPACE = { isSpaceRoute: true, isSettingsRoute: false, isAiRoute: false };
const AI = { isSpaceRoute: false, isSettingsRoute: false, isAiRoute: true };

describe("getSidebarCollapseState (rail-vs-hide truth table)", () => {
  it("home/global is a navigation sidebar → rails when collapsed", () => {
    expect(getSidebarCollapseState(HOME, true)).toEqual({
      showGlobalSidebar: true,
      railsWhenCollapsed: true,
      isRail: false,
    });
    expect(getSidebarCollapseState(HOME, false)).toEqual({
      showGlobalSidebar: true,
      railsWhenCollapsed: true,
      isRail: true,
    });
  });

  // Regression guard for the Settings-sidebar-vanishing bug: settings MUST rail,
  // never hide. If someone drops settings from railsWhenCollapsed, the asserts
  // below flip and the sidebar hides again — this test fails loudly.
  it("settings is a navigation sidebar → rails when collapsed, never hides", () => {
    const collapsed = getSidebarCollapseState(SETTINGS, false);
    expect(collapsed.showGlobalSidebar).toBe(false);
    expect(collapsed.railsWhenCollapsed).toBe(true);
    expect(collapsed.isRail).toBe(true);
    expect(getSidebarCollapseState(SETTINGS, true).isRail).toBe(false);
  });

  // CCC (#1/#2): the space page-tree used to HIDE on collapse — Mantine slid the
  // whole navbar off-screen (translateX), which read as "some sidebars vanish and
  // slide". Every navbar sidebar now RAILS to the 52px icon strip instead, so the
  // collapse is consistent and nothing slides. This guards against a regression to
  // the hide-on-collapse behavior.
  it("space page-tree rails when collapsed, never hides", () => {
    const collapsed = getSidebarCollapseState(SPACE, false);
    expect(collapsed.railsWhenCollapsed).toBe(true);
    expect(collapsed.isRail).toBe(true);
    expect(getSidebarCollapseState(SPACE, true).isRail).toBe(false);
  });

  it("AI chat rails when collapsed, never hides", () => {
    const collapsed = getSidebarCollapseState(AI, false);
    expect(collapsed.railsWhenCollapsed).toBe(true);
    expect(collapsed.isRail).toBe(true);
    expect(getSidebarCollapseState(AI, true).isRail).toBe(false);
  });

  it("every navbar sidebar rails — none hides on desktop collapse", () => {
    for (const route of [HOME, SETTINGS, SPACE, AI]) {
      expect(getSidebarCollapseState(route, false).railsWhenCollapsed).toBe(true);
    }
  });

  it("isRail is true only when the desktop toggle is off (collapsed)", () => {
    for (const route of [HOME, SETTINGS, SPACE, AI]) {
      expect(getSidebarCollapseState(route, true).isRail).toBe(false);
    }
  });
});
