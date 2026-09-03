import { AppShell, Container } from "@mantine/core";
import React, { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import SettingsSidebar from "@/components/settings/settings-sidebar.tsx";
import { useAtom } from "jotai";
import {
  asideStateAtom,
  desktopSidebarAtom,
  mobileSidebarAtom,
  sidebarWidthAtom,
} from "@/components/layouts/global/hooks/atoms/sidebar-atom.ts";
import { SpaceSidebar } from "@/features/space/components/sidebar/space-sidebar.tsx";
import AiChatSidebar from "@/ee/ai-chat/components/ai-chat-sidebar.tsx";
import { AppHeader } from "@/components/layouts/global/app-header.tsx";
import Aside from "@/components/layouts/global/aside.tsx";
import classes from "./app-shell.module.css";
import { useTrialEndAction } from "@/ee/hooks/use-trial-end-action.tsx";
import { useToggleSidebar } from "@/components/layouts/global/hooks/hooks/use-toggle-sidebar.ts";
import GlobalSidebar from "@/components/layouts/global/global-sidebar.tsx";
import { getSidebarCollapseState } from "@/components/layouts/global/sidebar-collapse.ts";
import { ASIDE_PANEL_ID } from "@/hooks/use-toggle-aside.tsx";
import { MAIN_CONTENT_ID, SkipToMain } from "@/components/ui/skip-to-main.tsx";
import {
  ASIDE_WIDTH,
  HEADER_HEIGHT,
  NAVBAR_BREAKPOINT,
  RAIL_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_WIDTH,
} from "@/features/layout/layout-tokens.ts";

export default function GlobalAppShell({
  children,
}: {
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  useTrialEndAction();
  const [mobileOpened] = useAtom(mobileSidebarAtom);
  const toggleMobile = useToggleSidebar(mobileSidebarAtom);
  const [desktopOpened] = useAtom(desktopSidebarAtom);
  const [{ isAsideOpen, tab: asideTab }] = useAtom(asideStateAtom);
  const [sidebarWidth, setSidebarWidth] = useAtom(sidebarWidthAtom);
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef(null);

  const startResizing = React.useCallback((mouseDownEvent) => {
    mouseDownEvent.preventDefault();
    setIsResizing(true);
  }, []);

  const stopResizing = React.useCallback(() => {
    setIsResizing(false);
  }, []);

  const resize = React.useCallback(
    (mouseMoveEvent) => {
      if (isResizing) {
        const newWidth =
          mouseMoveEvent.clientX -
          sidebarRef.current.getBoundingClientRect().left;
        if (newWidth < SIDEBAR_MIN_WIDTH) {
          setSidebarWidth(SIDEBAR_MIN_WIDTH);
          return;
        }
        if (newWidth > SIDEBAR_MAX_WIDTH) {
          setSidebarWidth(SIDEBAR_MAX_WIDTH);
          return;
        }
        setSidebarWidth(newWidth);
      }
    },
    [isResizing],
  );

  useEffect(() => {
    //https://codesandbox.io/p/sandbox/kz9de
    window.addEventListener("mousemove", resize);
    window.addEventListener("mouseup", stopResizing);
    return () => {
      window.removeEventListener("mousemove", resize);
      window.removeEventListener("mouseup", stopResizing);
    };
  }, [resize, stopResizing]);

  const location = useLocation();
  const isSettingsRoute = location.pathname.startsWith("/settings");
  const isSpaceRoute = location.pathname.startsWith("/s/");
  const isAiRoute = location.pathname.startsWith("/ai");
  const isPageRoute = location.pathname.includes("/p/");
  // CCC: the rail-vs-hide decision is a pure, unit-tested helper (sidebar-collapse.ts)
  // so it can't silently regress. EVERY navbar sidebar (home, settings, the space
  // page-tree, AI chat) rails to RAIL_WIDTH when the desktop toggle is off — none
  // hide, so nothing slides off-screen (#1/#2). `railsWhenCollapsed` drives both the
  // navbar width and the collapsed.desktop decision below; each sidebar hides the
  // sections that can't reduce to an icon (tree/history) via its own `railHidden`.
  const { showGlobalSidebar, railsWhenCollapsed, isRail } = getSidebarCollapseState(
    { isSpaceRoute, isSettingsRoute, isAiRoute },
    desktopOpened,
  );

  return (
    <>
      <SkipToMain />
      {/* CCC: header height (HEADER_HEIGHT) gives the Vanderbilt/CCC lockup room to
          breathe. Keep in sync with the coupled `.aside` margin-top in
          app-shell.module.css. */}
      <AppShell
      header={{ height: HEADER_HEIGHT }}
      navbar={{
        // CCC: on desktop EVERY sidebar becomes a RAIL_WIDTH icon rail when
        // "collapsed" rather than hiding — including the resizable space page-tree,
        // whose width otherwise tracks `sidebarWidth`. Mobile always uses the full
        // overlay (rail styles are gated to sm+ in each sidebar's module.css).
        width: isSpaceRoute
          ? isRail
            ? RAIL_WIDTH
            : sidebarWidth
          : { base: SIDEBAR_WIDTH, sm: isRail ? RAIL_WIDTH : SIDEBAR_WIDTH },
        breakpoint: NAVBAR_BREAKPOINT,
        collapsed: {
          mobile: !mobileOpened,
          // Every navbar sidebar rails (never fully hides) on desktop, so the
          // navbar never slides off-screen; `isRail` (below) controls the width.
          desktop: railsWhenCollapsed ? false : !desktopOpened,
        },
      }}
      aside={
        isPageRoute && {
          width: ASIDE_WIDTH,
          breakpoint: NAVBAR_BREAKPOINT,
          collapsed: { mobile: !isAsideOpen, desktop: !isAsideOpen },
        }
      }
      padding="md"
    >
      <AppShell.Header px="md" className={classes.header}>
        <AppHeader />
      </AppShell.Header>
      <AppShell.Navbar
        className={classes.navbar}
        withBorder={false}
        ref={sidebarRef}
        aria-label={
          isSpaceRoute
            ? t("Space navigation")
            : isSettingsRoute
              ? t("Settings navigation")
              : isAiRoute
                ? t("AI navigation")
                : t("Main navigation")
        }
      >
        {/* No drag-to-resize while railed — the rail is a fixed 52px. */}
        {isSpaceRoute && !isRail && (
          <div className={classes.resizeHandle} onMouseDown={startResizing} />
        )}
        {isSpaceRoute && <SpaceSidebar collapsed={isRail} />}
        {isSettingsRoute && <SettingsSidebar collapsed={isRail} />}
        {isAiRoute && <AiChatSidebar collapsed={isRail} />}
        {showGlobalSidebar && <GlobalSidebar collapsed={isRail} />}
      </AppShell.Navbar>
      <AppShell.Main id={MAIN_CONTENT_ID} tabIndex={-1}>
        {isSettingsRoute ? (
          <Container size={900} pb={80}>
            {children}
          </Container>
        ) : (
          children
        )}
      </AppShell.Main>

      {isPageRoute && (
        <AppShell.Aside
          id={ASIDE_PANEL_ID}
          tabIndex={-1}
          className={classes.aside}
          p="md"
          withBorder={false}
          aria-label={
            asideTab === "comments"
              ? t("Comments")
              : asideTab === "toc"
                ? t("Table of contents")
                : asideTab === "chat"
                  ? t("AI Chat")
                  : asideTab === "details"
                    ? t("Details")
                    : undefined
          }
        >
          <Aside />
        </AppShell.Aside>
      )}
    </AppShell>
    </>
  );
}
