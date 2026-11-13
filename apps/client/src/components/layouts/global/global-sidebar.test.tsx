// wiki-v2 UI cleanup: the global sidebar (upstream seam #36). "Invite People" posts to invites/create,
// which remote mode refuses (404): it shows only to a workspace admin through useUserRole() (real here),
// which answers member for everyone in remote mode (#636). A gate on the raw stored users.role would show
// it to a remote owner, and this file goes red. Hiding it is UX; the server refusal is the control.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter } from "react-router-dom";
import { getDefaultStore } from "jotai";

const nativeState = vi.hoisted(() => ({ value: false }));
vi.mock("@/features/auth-native/lib/auth-mode.ts", () => ({
  isNativeAuthEnabled: () => nativeState.value,
}));
vi.mock("@/features/user/atoms/current-user-atom.ts", async () => {
  const { atom } = await import("jotai");
  return { currentUserAtom: atom<unknown>(null) };
});
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("@/components/layouts/global/hooks/atoms/sidebar-atom", async () => {
  const { atom } = await import("jotai");
  return { mobileSidebarAtom: atom(false) };
});
vi.mock("@/components/layouts/global/hooks/hooks/use-toggle-sidebar", () => ({
  useToggleSidebar: () => () => {},
}));
vi.mock("@/features/favorite/queries/favorite-query", () => ({
  useFavoritesQuery: () => ({ data: { pages: [{ items: [] }] }, isPending: false }),
}));
vi.mock("@/components/ui/custom-avatar", () => ({ CustomAvatar: () => null }));
vi.mock(
  "@/features/workspace/components/members/components/workspace-invite-form",
  () => ({ WorkspaceInviteForm: () => "invite-form" }),
);

import GlobalSidebar from "./global-sidebar";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom.ts";

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
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

// The stored users.role. useUserRole() reads it only in native mode.
function signInAs(role: "owner" | "admin" | "member") {
  getDefaultStore().set(currentUserAtom as never, {
    user: { id: "u1", name: "Ada", email: "ada@example.edu", role },
    workspace: { id: "w1", name: "Wiki", settings: {} },
  } as never);
}

beforeEach(() => {
  nativeState.value = false;
});
afterEach(cleanup);

function renderSidebar(collapsed = false) {
  return render(
    <MantineProvider env="test">
      <MemoryRouter initialEntries={["/home"]}>
        <GlobalSidebar collapsed={collapsed} />
      </MemoryRouter>
    </MantineProvider>,
  );
}

const inviteButton = () => screen.queryByRole("button", { name: "Invite People" });

describe("GlobalSidebar — Invite People", () => {
  it.each(["owner", "admin", "member"] as const)(
    "remote %s: no Invite People (the platform owns invites)",
    (role) => {
      signInAs(role);
      renderSidebar();
      expect(inviteButton()).toBeNull();
      expect(screen.queryByText("Invite People")).toBeNull();
      // Settings stays for everyone.
      expect(screen.getByRole("link", { name: "Settings" })).toBeTruthy();
    },
  );

  it("remote owner in the collapsed rail: no Invite People either", () => {
    signInAs("owner");
    renderSidebar(true);
    expect(inviteButton()).toBeNull();
    expect(screen.queryByText("Invite People")).toBeNull();
  });

  it.each(["owner", "admin"] as const)(
    "native %s: Invite People opens the invite form",
    async (role) => {
      nativeState.value = true;
      signInAs(role);
      renderSidebar();
      expect(screen.queryByText("invite-form")).toBeNull();
      fireEvent.click(inviteButton()!);
      expect(await screen.findByText("invite-form")).toBeTruthy();
    },
  );

  it("native member: no Invite People", () => {
    nativeState.value = true;
    signInAs("member");
    renderSidebar();
    expect(inviteButton()).toBeNull();
  });
});

describe("GlobalSidebar — the EE Templates item is gone with its route (ADR 0035)", () => {
  it.each([false, true])("native=%s owner: Home, Favorites, Spaces and no Templates", (native) => {
    nativeState.value = native;
    signInAs("owner");
    renderSidebar();
    expect(screen.getByRole("link", { name: "Home" }).getAttribute("href")).toBe("/home");
    expect(screen.getByRole("link", { name: "Favorites" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Spaces" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Templates" })).toBeNull();
    for (const link of screen.getAllByRole("link")) {
      expect(link.getAttribute("href")).not.toMatch(/^\/templates/);
    }
  });
});
