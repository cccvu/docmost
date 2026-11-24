import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter } from "react-router-dom";

// The membership-management mode gate (the fix under test).
const nativeState = vi.hoisted(() => ({ value: false }));
vi.mock("@/features/auth-native/lib/auth-mode.ts", () => ({
  isNativeAuthEnabled: () => nativeState.value,
}));

// #858 T2: `data` can be set to undefined for the "space not loaded yet" rows.
const spaceQueryState = vi.hoisted(() => ({
  data: undefined as unknown,
}));
vi.mock("@/features/space/queries/space-query.ts", () => ({
  useSpaceQuery: () => ({ data: spaceQueryState.data, isLoading: false }),
}));

// By default a caller who CAN manage members by CASL — proves remote mode still goes read-only +
// note regardless of the space ability (the native controls would bypass the console). The
// wiki-v2 UI cleanup cases below flip it to a caller who can manage nothing, or (`only`) to a
// caller who can manage exactly one subject — so the console-link gate is pinned to its key.
// `real` defers to the actual CASL hook over the space's serialized rules (the not-loaded rows).
const abilityState = vi.hoisted(() => ({
  canManage: true,
  only: null as string | null,
  real: false,
}));
vi.mock("@/features/space/permissions/use-space-ability.ts", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/features/space/permissions/use-space-ability.ts")
  >();
  const can = (action: string, subject: string) =>
    abilityState.only
      ? action === "manage" && subject === abilityState.only
      : abilityState.canManage;
  const stub = {
    can,
    cannot: (action: string, subject: string) => !can(action, subject),
  };
  return {
    ...actual,
    useSpaceAbility: (rules: unknown) => {
      const real = actual.useSpaceAbility(rules as never);
      return abilityState.real ? real : stub;
    },
  };
});

// wiki-v2 UI cleanup: the console link also shows for a platform workspace admin.
// #858 P1: a spy, so the rows can pin when the admin-context query is read at all.
const adminState = vi.hoisted(() => ({
  gate: "hidden" as string,
  hook: vi.fn(),
}));
vi.mock("@/features/admin-entry/use-platform-admin-context.ts", () => ({
  usePlatformAdminContext: () => adminState.hook(),
}));

const securityState = vi.hoisted(() => ({ available: false }));
vi.mock("@/features/feature-availability/feature-gate.tsx", () => ({
  useSpaceSecurityAvailable: () => securityState.available,
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
  abilityState.real = false;
  adminState.gate = "hidden";
  adminState.hook.mockReset();
  adminState.hook.mockImplementation(() => adminState.gate);
  securityState.available = false;
  spaceQueryState.data = {
    id: "sp1",
    name: "My Space",
    membership: { permissions: null },
  };
});

function renderModal(opened = true) {
  return render(
    <MantineProvider>
      <MemoryRouter>
        <SpaceSettingsModal spaceId="sp1" opened={opened} onClose={() => {}} />
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

  // #858 F1: "reauth" is a platform admin whose admin context needs a fresh sign-in; the console
  // re-authenticates them, so they get the link, not "ask a space admin".
  it("platform admin whose session lapsed (gate reauth), no space Manage Member: the console note and link", () => {
    abilityState.only = "settings";
    adminState.gate = "reauth";
    renderModal();

    expect(screen.getByText(/managed in the Admin Console/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open the Admin Console/i })).toBeTruthy();
    expect(screen.queryByText("Ask a space admin to change who has access.")).toBeNull();
  });

  it.each(["hidden"])(
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

// #858 P1: the modal is mounted on every sidebar render, open or not. The admin-context read lives in a
// remote-only child of the Members panel, so a closed modal and native mode never read it.
describe("SpaceSettingsModal — admin-context read (#858 P1)", () => {
  it("closed modal: the admin context is not read", () => {
    renderModal(false);
    expect(adminState.hook).not.toHaveBeenCalled();
  });

  it("native mode: the admin context is not read", () => {
    nativeState.value = true;
    renderModal();
    expect(screen.getByTestId("members-list")).toBeTruthy();
    expect(adminState.hook).not.toHaveBeenCalled();
  });

  it("remote mode, open: the admin context is read", () => {
    renderModal();
    expect(adminState.hook).toHaveBeenCalled();
  });
});

// #858 T2: real CASL over a space whose membership has not loaded (`permissions` undefined).
describe("SpaceSettingsModal — space not loaded yet (#858 T2)", () => {
  it("remote, gate hidden: ask a space admin, no console link, no Security tab", () => {
    abilityState.real = true;
    securityState.available = true;
    spaceQueryState.data = undefined;
    renderModal();

    expect(screen.getByText("Ask a space admin to change who has access.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Open the Admin Console/i })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Security" })).toBeNull();
  });

  it("native: no Add button, read-only member list", () => {
    abilityState.real = true;
    nativeState.value = true;
    spaceQueryState.data = undefined;
    renderModal();

    expect(screen.queryByTestId("add-members")).toBeNull();
    expect(screen.getByTestId("members-list").getAttribute("data-readonly")).toBe("true");
  });

  it("control: real CASL with admin rules shows the Security tab and the console link", () => {
    abilityState.real = true;
    securityState.available = true;
    spaceQueryState.data = {
      id: "sp1",
      name: "My Space",
      membership: {
        permissions: [
          { action: "manage", subject: "settings" },
          { action: "manage", subject: "member" },
          { action: "manage", subject: "page" },
        ],
      },
    };
    renderModal();

    expect(screen.getByRole("tab", { name: "Security" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open the Admin Console/i })).toBeTruthy();
  });
});
