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
        if (newWidth < 220) {
          setSidebarWidth(220);
          return;
        }
        if (newWidth > 600) {
          setSidebarWidth(600);
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
  const RAIL_WIDTH = 52;
  // CCC: the rail-vs-hide decision is a pure, unit-tested helper (sidebar-collapse.ts)
  // so the Settings-rail fix can't silently regress. NAVIGATION sidebars (home,
  // settings) rail to RAIL_WIDTH when the desktop toggle is off; CONTENT sidebars
  // (the space page-tree, AI chat) keep the upstream show/hide — a full-width reading
  // view, since a tree/chat list has no meaningful icon rail. `railsWhenCollapsed`
  // drives both the navbar width and the collapsed.desktop decision below.
  const { showGlobalSidebar, railsWhenCollapsed, isRail } = getSidebarCollapseState(
    { isSpaceRoute, isSettingsRoute, isAiRoute },
    desktopOpened,
  );

  return (
    <>
      <SkipToMain />
      {/* CCC: header height raised from 45 → 56 to give the Vanderbilt/CCC lockup
          room to breathe. Keep in sync with the coupled `.aside` margin-top in
          app-shell.module.css. */}
      <AppShell
      header={{ height: 56 }}
      navbar={{
        // CCC: on desktop the home & settings sidebars become a 52px icon rail
        // when "collapsed" rather than hiding; mobile always uses the full 300px
        // overlay (rail styles are gated to sm+ in the sidebars' module.css).
        width: isSpaceRoute
          ? sidebarWidth
          : { base: 300, sm: isRail ? RAIL_WIDTH : 300 },
        breakpoint: "sm",
        collapsed: {
          mobile: !mobileOpened,
          // Navigation sidebars (home, settings) never fully hide on desktop
          // (they rail); the space page-tree and AI chat keep the upstream
          // show/hide toggle.
          desktop: railsWhenCollapsed ? false : !desktopOpened,
        },
      }}
      aside={
        isPageRoute && {
          width: 350,
          breakpoint: "sm",
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
        {isSpaceRoute && (
          <div className={classes.resizeHandle} onMouseDown={startResizing} />
        )}
        {isSpaceRoute && <SpaceSidebar />}
        {isSettingsRoute && <SettingsSidebar collapsed={isRail} />}
        {isAiRoute && <AiChatSidebar />}
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
