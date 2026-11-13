// wiki-v2 UI cleanup: the space Trash page offers permanent "Delete" only to a caller with space
// Manage Settings — the predicate deleted-page-banner.tsx uses and the server enforces (page delete
// with permanentlyDelete). "Restore" is unchanged. Real CASL over the space's serialized rules.
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const ADMIN_RULES = [
  { action: "manage", subject: "settings" },
  { action: "manage", subject: "member" },
  { action: "manage", subject: "page" },
];
const WRITER_RULES = [
  { action: "read", subject: "settings" },
  { action: "read", subject: "member" },
  { action: "manage", subject: "page" },
];

const spaceState = vi.hoisted(() => ({ rules: [] as unknown[] }));
vi.mock("@/features/space/queries/space-query", () => ({
  useGetSpaceBySlugQuery: () => ({
    data: {
      id: "sp1",
      slug: "eng",
      membership: { permissions: spaceState.rules },
    },
  }),
}));

vi.mock("@/features/page/queries/page-query", () => ({
  useDeletedPagesQuery: () => ({
    data: {
      items: [
        {
          id: "p1",
          title: "Old page",
          icon: null,
          isBase: false,
          deletedBy: null,
          deletedAt: "2026-11-01T00:00:00Z",
        },
      ],
      meta: { hasPrevPage: false, hasNextPage: false },
    },
    isLoading: false,
  }),
  useRestorePageMutation: () => ({ mutateAsync: vi.fn() }),
  useDeletePageMutation: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("@/features/page/hooks/use-restore-page-modal.tsx", () => ({
  useRestorePageModal: () => ({ openRestoreModal: vi.fn() }),
}));
vi.mock("@/features/page/trash/components/trash-banner.tsx", () => ({
  TrashBanner: () => null,
}));
vi.mock("@/features/page/trash/components/trash-page-content-modal", () => ({
  default: () => null,
}));
vi.mock("@/components/common/user-info.tsx", () => ({
  UserInfo: () => null,
}));
vi.mock("@/components/common/paginate.tsx", () => ({ default: () => null }));
vi.mock("@/components/common/page-list-icon", () => ({
  PageListIcon: () => null,
}));
vi.mock("@/lib/time", () => ({ formattedDate: () => "Nov 1" }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import Trash from "./trash";

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

beforeEach(() => {
  spaceState.rules = [];
});

afterEach(cleanup);

function openRowMenu() {
  render(
    <MantineProvider env="test">
      <MemoryRouter initialEntries={["/s/eng/trash"]}>
        <Routes>
          <Route path="/s/:spaceSlug/trash" element={<Trash />} />
        </Routes>
      </MemoryRouter>
    </MantineProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Page actions" }));
}

describe("Trash — permanent delete gating", () => {
  it("space admin (Manage Settings): Restore and Delete", () => {
    spaceState.rules = ADMIN_RULES;
    openRowMenu();

    expect(screen.getByRole("menuitem", { name: "Restore" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
  });

  it("space writer (Manage Page, no Manage Settings): Restore only", () => {
    spaceState.rules = WRITER_RULES;
    openRowMenu();

    expect(screen.getByRole("menuitem", { name: "Restore" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
  });
});
