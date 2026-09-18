import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter } from "react-router-dom";

// Gate the row action menu on the caller's admin role (the fix under test).
const roleState = vi.hoisted(() => ({ isAdmin: false }));
vi.mock("@/hooks/use-user-role.tsx", () => ({
  default: () => ({ isAdmin: roleState.isAdmin }),
}));

// One group so a row renders.
vi.mock("@/features/group/queries/group-query", () => ({
  useGetGroupsQuery: () => ({
    data: {
      items: [{ id: "g1", name: "Group One", description: "desc", memberCount: 2 }],
      meta: { hasPrevPage: false, hasNextPage: false, nextCursor: null },
    },
    isLoading: false,
  }),
}));

vi.mock("@/hooks/use-paginate-and-search.tsx", () => ({
  usePaginateAndSearch: () => ({
    search: "",
    cursor: undefined,
    goNext: () => {},
    goPrev: () => {},
    handleSearch: () => {},
  }),
}));

// Avoid importing the real app entry (side effects) for the prefetch queryClient.
vi.mock("@/main.tsx", () => ({ queryClient: { prefetchQuery: () => {} } }));
vi.mock("@/features/group/services/group-service.ts", () => ({
  getGroupMembers: () => Promise.resolve({}),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

// Isolate the gating decision from GroupActionMenu's internals.
vi.mock("@/features/group/components/group-action-menu.tsx", () => ({
  default: () => <div data-testid="group-action-menu" />,
}));

import GroupList from "./group-list";

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
  roleState.isAdmin = false;
});

function renderList() {
  return render(
    <MantineProvider>
      <MemoryRouter>
        <GroupList />
      </MemoryRouter>
    </MantineProvider>,
  );
}

describe("GroupList row actions (admin gating)", () => {
  it("shows the Edit/Delete action menu for an admin", () => {
    roleState.isAdmin = true;
    renderList();
    expect(screen.getByText("Group One")).toBeTruthy();
    expect(screen.getByTestId("group-action-menu")).toBeTruthy();
  });

  it("hides the action menu for a non-admin (no dead control)", () => {
    roleState.isAdmin = false;
    renderList();
    // The row still renders...
    expect(screen.getByText("Group One")).toBeTruthy();
    // ...but the three-dots Edit/Delete menu does not.
    expect(screen.queryByTestId("group-action-menu")).toBeNull();
  });
});
