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

// A caller who CAN manage members by CASL — proves remote mode still goes read-only + note
// regardless of the space ability (the native controls would bypass the console).
vi.mock("@/features/space/permissions/use-space-ability.ts", () => ({
  useSpaceAbility: () => ({ can: () => true, cannot: () => false }),
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
  it("remote mode: shows the Admin Console note, no Add button, read-only list", () => {
    nativeState.value = false; // remote
    renderModal();

    expect(screen.getByText(/managed in the Admin Console/i)).toBeTruthy();
    const link = screen.getByRole("link", { name: /Open the Admin Console/i });
    expect(link.getAttribute("href")).toBe("/console");

    expect(screen.queryByTestId("add-members")).toBeNull();
    expect(screen.getByTestId("members-list").getAttribute("data-readonly")).toBe(
      "true",
    );
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
