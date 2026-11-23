import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter } from "react-router-dom";
import { atom } from "jotai";
import type { ReactElement } from "react";
import type { AnnouncementState } from "./use-announcement";

// wiki-v2 #939 — the three shells mount the announcement strip: the header height is HEADER_HEIGHT plus
// BANNER_HEIGHT exactly while the strip shows, the strip is the header's first child, and the header row below it
// stays HEADER_HEIGHT tall (so `AppHeader`'s `h="100%"` row is not stretched over the strip). Rendered through the
// real shells with the announcement hook and the strip mocked. NOT upstream Docmost code.

const state = vi.hoisted(() => {
  // The sidebar atoms read localStorage when their module loads, before any hook runs.
  const mem = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => (mem.has(k) ? (mem.get(k) as string) : null),
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: () => null,
    length: 0,
  } as Storage;
  return { visible: false };
});

vi.mock("./use-announcement.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./use-announcement")>();
  return {
    ...real,
    useAnnouncement: (): AnnouncementState => ({
      visible: state.visible,
      announcement: null,
      phase: null,
      dismissible: false,
      now: 0,
      dismiss: () => {},
    }),
  };
});
vi.mock("./announcement-banner.tsx", () => ({
  AnnouncementBanner: ({ state: s }: { state: AnnouncementState }) =>
    s.visible ? <div data-testid="announcement-banner" /> : null,
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("@/components/theme-toggle.tsx", () => ({ ThemeToggle: () => null }));
vi.mock("@/features/brand/brand-logo.tsx", () => ({ Brand: () => null }));
vi.mock("@/features/public/components/public-auth-buttons.tsx", () => ({ PublicAuthButtons: () => null }));
vi.mock("@/features/workspace/queries/workspace-query.ts", () => ({
  useWorkspacePublicDataQuery: () => ({ data: undefined }),
}));
// global shell
vi.mock("@/components/settings/settings-sidebar.tsx", () => ({ default: () => null }));
vi.mock("@/features/space/components/sidebar/space-sidebar.tsx", () => ({ SpaceSidebar: () => null }));
vi.mock("@/ee/ai-chat/components/ai-chat-sidebar.tsx", () => ({ default: () => null }));
vi.mock("@/components/layouts/global/app-header.tsx", () => ({
  AppHeader: () => <div data-testid="app-header" />,
}));
vi.mock("@/components/layouts/global/aside.tsx", () => ({ default: () => null }));
vi.mock("@/ee/hooks/use-trial-end-action.tsx", () => ({ useTrialEndAction: () => {} }));
vi.mock("@/components/layouts/global/global-sidebar.tsx", () => ({ default: () => null }));
// share shell
vi.mock("@/features/share/queries/share-query.ts", () => ({
  useGetSharedPageTreeQuery: () => ({ data: undefined }),
}));
vi.mock("@/features/share/components/shared-tree.tsx", () => ({ default: () => null }));
vi.mock("@/features/editor/components/table-of-contents/table-of-contents.tsx", () => ({
  TableOfContents: () => null,
}));
vi.mock("@/features/editor/atoms/editor-atoms.ts", () => ({ readOnlyEditorAtom: atom(null) }));
vi.mock("@/features/search/components/search-control.tsx", () => ({
  SearchControl: () => null,
  SearchMobileControl: () => null,
}));
vi.mock("@/features/search/components/share-search-spotlight.tsx", () => ({
  ShareSearchSpotlight: () => null,
}));
vi.mock("@/features/search/constants", () => ({ shareSearchSpotlight: { open: () => {} } }));
vi.mock("@/features/share/components/share-branding.tsx", () => ({ default: () => null }));
vi.mock("@/features/share/utils", () => ({ buildSharedPageTree: () => null }));

import { PublicShell } from "@/features/public/components/public-shell";
import GlobalAppShell from "@/components/layouts/global/global-app-shell";
import ShareShell from "@/features/share/components/share-shell";

beforeAll(() => {
  // jsdom has no ResizeObserver; the share shell's aside ScrollArea uses one.
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  if (!window.matchMedia) {
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
});

afterEach(() => {
  cleanup();
  state.visible = false;
});

const SHELLS = [
  ["PublicShell", () => <PublicShell>body</PublicShell>, "/login"],
  ["GlobalAppShell", () => <GlobalAppShell>body</GlobalAppShell>, "/home"],
  ["ShareShell", () => <ShareShell>body</ShareShell>, "/share/abc/p/page"],
] as const;

/** Mantine writes the AppShell sizes as CSS variables into an inline <style>. */
function headerHeightVar(): string | undefined {
  const css = Array.from(document.querySelectorAll("style"))
    .map((s) => s.textContent ?? "")
    .join("\n");
  return css.match(/--app-shell-header-height:\s*([^;]+);/)?.[1]?.trim();
}

function renderShell(Shell: () => ReactElement, path: string) {
  return render(
    <MantineProvider env="test">
      <MemoryRouter initialEntries={[path]}>
        <Shell />
      </MemoryRouter>
    </MantineProvider>,
  );
}

describe.each(SHELLS)("%s mounts the announcement strip", (_name, Shell, path) => {
  it("keeps the plain header height (56) when no strip shows", () => {
    renderShell(Shell, path);
    expect(headerHeightVar()).toBe("calc(3.5rem * var(--mantine-scale))");
    expect(document.querySelector('[data-testid="announcement-banner"]')).toBeNull();
  });

  it("adds the strip's 40 px (96) when it shows, with the strip first and a 56 px header row under it", () => {
    state.visible = true;
    renderShell(Shell, path);
    expect(headerHeightVar()).toBe("calc(6rem * var(--mantine-scale))");
    const header = document.querySelector("header");
    expect(header).not.toBeNull();
    const [first, second] = Array.from(header!.children) as HTMLElement[];
    expect(first.dataset.testid).toBe("announcement-banner");
    expect(second.style.height).toBe("calc(3.5rem * var(--mantine-scale))");
  });
});
