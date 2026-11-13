import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter } from "react-router-dom";

// The membership-management mode gate (the fix under test).
const nativeState = vi.hoisted(() => ({ value: false }));
vi.mock("@/features/auth-native/lib/auth-mode.ts", () => ({
  isNativeAuthEnabled: () => nativeState.value,
}));

vi.mock("@/features/space/queries/space-query.ts", () => ({
  useSpaceQuery: () => ({
    data: { id: "sp1", name: "My Space", membership: { permissions: null } },
    isLoading: false,
  }),
}));

// By default a caller who CAN manage members by CASL — proves remote mode still goes read-only +
// note regardless of the space ability (the native controls would bypass the console). The
// wiki-v2 UI cleanup cases below flip it to a caller who can manage nothing, or (`only`) to a
// caller who can manage exactly one subject — so the console-link gate is pinned to its key.
const abilityState = vi.hoisted(() => ({
  canManage: true,
  only: null as string | null,
}));
vi.mock("@/features/space/permissions/use-space-ability.ts", () => {
  const can = (action: string, subject: string) =>
    abilityState.only
      ? action === "manage" && subject === abilityState.only
      : abilityState.canManage;
  return {
    useSpaceAbility: () => ({
      can,
      cannot: (action: string, subject: string) => !can(action, subject),
    }),
  };
});

// wiki-v2 UI cleanup: the console link also shows for a platform workspace admin.
const adminState = vi.hoisted(() => ({ gate: "hidden" as string }));
vi.mock("@/features/admin-entry/use-platform-admin-context.ts", () => ({
  usePlatformAdminContext: () => adminState.gate,
}));

vi.mock("@/features/feature-availability/feature-gate.tsx", () => ({
  useSpaceSecurityAvailable: () => false,
}));

// Expose the readOnly prop the panel receives so we can assert it.
vi.mock("@/features/space/components/space-members.tsx", () => ({
  default: ({ readOnly }: { readOnly?: boolean }) => (
    <div data-testid="members-list" data-readonly={String(!!readOnly)} />
  ),
}));
vi.mock("@/features/space/components/add-space-members-modal.tsx", () => ({
  default: () => <div data-testid="add-members" />,
}));
vi.mock("@/features/space/components/space-details.tsx", () => ({
  default: () => <div data-testid="space-details" />,
}));
vi.mock("@/features/space/components/space-security-settings.tsx", () => ({
  default: () => <div data-testid="space-security" />,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import SpaceSettingsModal from "./settings-modal";

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
    (window as unknown as { ResizeObserver?: unknown }).ResizeObserver =
      ResizeObserverStub;
  }
});

beforeEach(() => {
  nativeState.value = false;
  abilityState.canManage = true;
  abilityState.only = null;
  adminState.gate = "hidden";
});

function renderModal() {
  return render(
    <MantineProvider>
      <MemoryRouter>
        <SpaceSettingsModal spaceId="sp1" opened onClose={() => {}} />
      </MemoryRouter>
    </MantineProvider>,
  );
}

describe("SpaceSettingsModal — members management gating", () => {
  it("remote mode: shows the Admin Console note, no Add button and no member list (#797)", () => {
    nativeState.value = false; // remote
    renderModal();

    expect(screen.getByText(/managed in the Admin Console/i)).toBeTruthy();
    const link = screen.getByRole("link", { name: /Open the Admin Console/i });
    expect(link.getAttribute("href")).toBe("/console");

    expect(screen.queryByTestId("add-members")).toBeNull();
    // The server refuses the native member read in remote mode (directoryRead, 404), so the
    // list is not rendered at all: an empty table would read as "no members".
    expect(screen.queryByTestId("members-list")).toBeNull();
  });

  it("native/standalone mode: keeps the Add button and editable list, no note", () => {
    nativeState.value = true; // native
    renderModal();

    expect(screen.queryByText(/managed in the Admin Console/i)).toBeNull();
    expect(screen.getByTestId("add-members")).toBeTruthy();
    expect(screen.getByTestId("members-list").getAttribute("data-readonly")).toBe(
      "false",
    );
  });
});

describe("SpaceSettingsModal — remote Admin Console link (wiki-v2 UI cleanup)", () => {
  it("space member manager (not a platform admin): the console note and link", () => {
    abilityState.only = "member"; // Manage Member and nothing else
    adminState.gate = "hidden";
    renderModal();

    expect(screen.getByText(/managed in the Admin Console/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open the Admin Console/i })).toBeTruthy();
    expect(screen.queryByText("Ask a space admin to change who has access.")).toBeNull();
  });

  it("platform workspace admin without space Manage Member: the console note and link", () => {
    abilityState.canManage = false;
    adminState.gate = "admin";
    renderModal();

    expect(screen.getByRole("link", { name: /Open the Admin Console/i })).toBeTruthy();
    expect(screen.queryByText("Ask a space admin to change who has access.")).toBeNull();
  });

  it.each(["hidden", "reauth"])(
    "no space Manage Member, not a platform admin (gate %s): ask a space admin, no console link",
    (gate) => {
      // Manage Settings alone must not open the link: the gate is keyed on Manage Member.
      abilityState.only = "settings";
      adminState.gate = gate;
      renderModal();

      expect(screen.getByText("Ask a space admin to change who has access.")).toBeTruthy();
      expect(screen.queryByRole("link", { name: /Open the Admin Console/i })).toBeNull();
      expect(screen.queryByText(/managed in the Admin Console/i)).toBeNull();
      expect(screen.queryByTestId("add-members")).toBeNull();
      expect(screen.queryByTestId("members-list")).toBeNull();
    },
  );

  it("native mode is unaffected: no note, read-only list for a non-manager", () => {
    nativeState.value = true;
    abilityState.canManage = false;
    renderModal();

    expect(screen.queryByText("Ask a space admin to change who has access.")).toBeNull();
    expect(screen.queryByRole("link", { name: /Open the Admin Console/i })).toBeNull();
    expect(screen.queryByTestId("add-members")).toBeNull();
    expect(screen.getByTestId("members-list").getAttribute("data-readonly")).toBe("true");
  });
});
