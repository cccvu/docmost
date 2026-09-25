import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter } from "react-router-dom";

// The space-delete mode gate (the fix under test, #502).
const nativeState = vi.hoisted(() => ({ value: false }));
vi.mock("@/features/auth-native/lib/auth-mode.ts", () => ({
  isNativeAuthEnabled: () => nativeState.value,
}));

// The console link is shown only to a platform workspace admin.
const adminState = vi.hoisted(() => ({ gate: "hidden" as string }));
vi.mock("@/features/admin-entry/use-platform-admin-context.ts", () => ({
  usePlatformAdminContext: () => adminState.gate,
}));

vi.mock("@/features/space/queries/space-query.ts", () => ({
  useSpaceQuery: () => ({
    data: { id: "sp1", name: "My Space", logo: null },
    isLoading: false,
    refetch: () => Promise.resolve(),
  }),
}));

// Avoid importing the real app entry (side effects) for the icon-upload queryClient.
vi.mock("@/main.tsx", () => ({ queryClient: { invalidateQueries: () => {} } }));
vi.mock("@/features/attachments/services/attachment-service.ts", () => ({
  uploadSpaceIcon: () => Promise.resolve(),
  removeSpaceIcon: () => Promise.resolve(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// Isolate the gating decision from the heavy children.
vi.mock("@/features/space/components/edit-space-form.tsx", () => ({
  EditSpaceForm: () => <div data-testid="edit-space-form" />,
}));
vi.mock("@/components/common/avatar-uploader.tsx", () => ({
  default: () => <div data-testid="avatar-uploader" />,
}));
vi.mock("@/components/common/export-modal.tsx", () => ({
  default: () => <div data-testid="export-modal" />,
}));
vi.mock("./delete-space-modal", () => ({
  default: () => <button type="button">Delete</button>,
}));

import SpaceDetails from "./space-details";

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
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
      ResizeObserverStub;
    (window as unknown as { ResizeObserver?: unknown }).ResizeObserver =
      ResizeObserverStub;
  }
});

beforeEach(() => {
  nativeState.value = false;
  adminState.gate = "hidden";
});

function renderDetails(readOnly = false) {
  return render(
    <MantineProvider>
      <MemoryRouter>
        <SpaceDetails spaceId="sp1" readOnly={readOnly} />
      </MemoryRouter>
    </MantineProvider>,
  );
}

const ARCHIVE_ONLY = /can't be permanently deleted here/i;

describe("SpaceDetails — space delete gating (#502)", () => {
  it("remote mode, platform admin: no Delete button, archive-only note + console link", () => {
    nativeState.value = false; // remote
    adminState.gate = "admin";
    renderDetails();

    expect(screen.getByText("Delete space")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.getByText(ARCHIVE_ONLY)).toBeTruthy();
    const link = screen.getByRole("link", { name: /Open the Admin Console/i });
    expect(link.getAttribute("href")).toBe("/console");
    // The Export row is untouched.
    expect(screen.getByRole("button", { name: "Export" })).toBeTruthy();
  });

  it("remote mode, non-admin: no Delete button, archive-only note, no console link", () => {
    nativeState.value = false; // remote
    adminState.gate = "hidden";
    renderDetails();

    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.getByText(ARCHIVE_ONLY)).toBeTruthy();
    expect(
      screen.queryByRole("link", { name: /Open the Admin Console/i }),
    ).toBeNull();
  });

  it("native/standalone mode: keeps the upstream Delete button, no note", () => {
    nativeState.value = true; // native
    adminState.gate = "admin";
    renderDetails();

    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
    expect(
      screen.getByText("Delete this space with all its pages and data."),
    ).toBeTruthy();
    expect(screen.queryByText(ARCHIVE_ONLY)).toBeNull();
    expect(
      screen.queryByRole("link", { name: /Open the Admin Console/i }),
    ).toBeNull();
  });

  it("native mode, read-only: no Delete row at all (upstream behavior)", () => {
    nativeState.value = true; // native
    renderDetails(true);

    expect(screen.queryByText("Delete space")).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.queryByText(ARCHIVE_ONLY)).toBeNull();
  });
});
