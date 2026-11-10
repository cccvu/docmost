import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter } from "react-router-dom";

// CCC (wiki-v2 #797): the native directory screens are hidden in remote mode.
const nativeState = vi.hoisted(() => ({ value: false }));
vi.mock("@/features/auth-native/lib/auth-mode.ts", () => ({
  isNativeAuthEnabled: () => nativeState.value,
}));
vi.mock("@/hooks/use-user-role.tsx", () => ({
  default: () => ({ isAdmin: true, isOwner: true }),
}));
vi.mock("@/lib/config.ts", async (orig) => ({
  ...(await orig<object>()),
  isCloud: () => false,
}));
vi.mock("@/hooks/use-settings-navigation", () => ({
  useSettingsNavigation: () => ({ goBack: () => {} }),
}));
vi.mock("@/components/settings/settings-queries.tsx", () => {
  const noop = () => {};
  return {
    prefetchApiKeyManagement: noop,
    prefetchApiKeys: noop,
    prefetchBilling: noop,
    prefetchGroups: noop,
    prefetchLicense: noop,
    prefetchScimTokens: noop,
    prefetchShares: noop,
    prefetchSpaces: noop,
    prefetchSsoProviders: noop,
    prefetchWorkspaceMembers: noop,
    prefetchAuditLogs: noop,
    prefetchVerifiedPages: noop,
  };
});
vi.mock("@/components/layouts/global/hooks/atoms/sidebar-atom.ts", async () => {
  const { atom } = await import("jotai");
  return { mobileSidebarAtom: atom(false) };
});
vi.mock("@/components/layouts/global/hooks/hooks/use-toggle-sidebar.ts", () => ({
  useToggleSidebar: () => () => {},
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import SettingsSidebar from "./settings-sidebar";

beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
  if (!(globalThis as { ResizeObserver?: unknown }).ResizeObserver) {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
  }
});

beforeEach(() => {
  nativeState.value = false;
});

function renderSidebar() {
  return render(
    <MantineProvider>
      <MemoryRouter>
        <SettingsSidebar />
      </MemoryRouter>
    </MantineProvider>,
  );
}

describe("SettingsSidebar — native directory screens (#797)", () => {
  it("remote mode: no Members or Groups entry (the server does not serve them); Spaces stays", () => {
    renderSidebar();
    expect(screen.queryByRole("link", { name: "Members" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Groups" })).toBeNull();
    expect(screen.getByRole("link", { name: "Spaces" })).toBeTruthy();
  });

  it("native mode: Members and Groups are listed", () => {
    nativeState.value = true;
    renderSidebar();
    expect(screen.getByRole("link", { name: "Members" }).getAttribute("href")).toBe(
      "/settings/members",
    );
    expect(screen.getByRole("link", { name: "Groups" }).getAttribute("href")).toBe(
      "/settings/groups",
    );
  });
});
