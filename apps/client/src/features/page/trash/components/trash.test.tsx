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
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
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

const spaceState = vi.hoisted(() => ({
  rules: [] as unknown[] | undefined,
}));
vi.mock("@/features/space/queries/space-query", () => ({
  useGetSpaceBySlugQuery: () => ({
    data: {
      id: "sp1",
      slug: "eng",
      membership: { permissions: spaceState.rules },
    },
  }),
}));

const ROW = {
  id: "p1",
  title: "Old page",
  icon: null,
  isBase: false,
  deletedBy: null,
  deletedAt: "2026-11-01T00:00:00Z",
};
const listState = vi.hoisted(() => ({
  items: [] as unknown[],
  deleteMutateAsync: (async () => {}) as (id: string) => Promise<void>,
}));
vi.mock("@/features/page/queries/page-query", () => ({
  useDeletedPagesQuery: () => ({
    data: {
      items: listState.items,
      meta: { hasPrevPage: false, hasNextPage: false },
    },
    isLoading: false,
  }),
  useRestorePageMutation: () => ({ mutateAsync: vi.fn() }),
  useDeletePageMutation: () => ({
    mutateAsync: (id: string) => listState.deleteMutateAsync(id),
  }),
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
  listState.items = [ROW];
  listState.deleteMutateAsync = async () => {};
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

describe("Trash — space not loaded yet (#858 T2)", () => {
  it("permissions undefined: Restore only, no Delete (fails closed)", () => {
    spaceState.rules = undefined;
    openRowMenu();

    expect(screen.getByRole("menuitem", { name: "Restore" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
  });
});

// wiki-v2 #913: the permanent delete removes its own row, and with it the focused "Page actions"
// button. Focus must land on the main content, never fall to <body>.
describe("Trash — focus after a row delete (#913)", () => {
  function renderTrash() {
    const tree = () => (
      <MantineProvider env="test">
        <ModalsProvider>
          <main id="main-content" tabIndex={-1}>
            <MemoryRouter initialEntries={["/s/eng/trash"]}>
              <Routes>
                <Route path="/s/:spaceSlug/trash" element={<Trash />} />
              </Routes>
            </MemoryRouter>
          </main>
        </ModalsProvider>
      </MantineProvider>
    );
    const view = render(tree());
    return () => view.rerender(tree());
  }

  it("confirm delete, the list refetches without the row: focus is on the main content", async () => {
    spaceState.rules = ADMIN_RULES;
    let deleted!: () => void;
    listState.deleteMutateAsync = () =>
      new Promise<void>((resolve) => {
        deleted = resolve;
      });
    const refetch = renderTrash();

    const trigger = screen.getByRole("button", { name: "Page actions" });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      Array.from(dialog.querySelectorAll("button")).find(
        (b) => b.textContent === "Delete",
      )!,
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Mantine returns focus to the trigger once the dialog closes.
    trigger.focus();

    await act(async () => deleted());
    listState.items = [];
    act(() => refetch());

    expect(screen.queryByRole("button", { name: "Page actions" })).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.id).toBe("main-content");
  });

  it("no confirm, the list changes anyway: focus is left alone", () => {
    spaceState.rules = ADMIN_RULES;
    const refetch = renderTrash();
    const trigger = screen.getByRole("button", { name: "Page actions" });
    trigger.focus();
    listState.items = [];
    act(() => refetch());
    expect(document.activeElement).toBe(document.body);
  });
});

