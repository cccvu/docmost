// wiki-v2 UI cleanup: the space menu offers "Export space" (and mounts its modal) only to a caller
// with space Manage Settings — what the server's spaces/export requires (export.controller.ts).
// Import pages and Trash keep their Manage Page gate. Real CASL over the space's serialized rules.
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
vi.mock("@/features/space/queries/space-query.ts", () => ({
  useGetSpaceBySlugQuery: () => ({
    data: {
      id: "sp1",
      slug: "eng",
      name: "Engineering",
      logo: null,
      membership: { permissions: spaceState.rules },
    },
  }),
}));

vi.mock("@/features/space/queries/space-watcher-query.ts", () => ({
  useSpaceWatchStatusQuery: () => ({ data: { watching: false } }),
  useWatchSpaceMutation: () => ({ mutate: vi.fn() }),
  useUnwatchSpaceMutation: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/features/favorite/queries/favorite-query", () => ({
  useFavoriteIds: () => new Set<string>(),
  useAddFavoriteMutation: () => ({ mutate: vi.fn() }),
  useRemoveFavoriteMutation: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/features/page/tree/hooks/use-tree-mutation.ts", () => ({
  useTreeMutation: () => ({ handleCreate: vi.fn() }),
}));
vi.mock("@/features/page/tree/components/space-tree.tsx", () => ({
  default: () => null,
}));
vi.mock("@/features/space/components/settings-modal.tsx", () => ({
  default: () => null,
}));
vi.mock("@/features/page/components/page-import-modal.tsx", () => ({
  default: () => <div data-testid="import-modal" />,
}));
vi.mock("@/components/common/export-modal", () => ({
  default: () => <div data-testid="export-modal" />,
}));
vi.mock("./switch-space", () => ({ SwitchSpace: () => null }));
vi.mock("@/ee/template/components/template-picker-modal", () => ({
  default: () => null,
}));
vi.mock("@/ee/hooks/use-feature", () => ({ useHasFeature: () => false }));
vi.mock("@/components/layouts/global/hooks/atoms/sidebar-atom.ts", async () => {
  const { atom } = await import("jotai");
  return { mobileSidebarAtom: atom(false) };
});
vi.mock("@/components/layouts/global/hooks/hooks/use-toggle-sidebar.ts", () => ({
  useToggleSidebar: () => vi.fn(),
}));
vi.mock("@/features/search/constants", () => ({
  searchSpotlight: { open: vi.fn() },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { SpaceSidebar } from "./space-sidebar";

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

function openSpaceMenu() {
  render(
    <MantineProvider env="test">
      <MemoryRouter initialEntries={["/s/eng"]}>
        <Routes>
          <Route path="/s/:spaceSlug" element={<SpaceSidebar />} />
        </Routes>
      </MemoryRouter>
    </MantineProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Space menu" }));
}

describe("SpaceSidebar — space menu Export gating", () => {
  it("space admin (Manage Settings): Import, Export and Trash; export modal mounted", () => {
    spaceState.rules = ADMIN_RULES;
    openSpaceMenu();

    expect(screen.getByRole("menuitem", { name: "Import pages" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Export space" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Trash" })).toBeTruthy();
    expect(screen.getByTestId("export-modal")).toBeTruthy();
  });

  it("space writer (Manage Page, no Manage Settings): Import and Trash, no Export", () => {
    spaceState.rules = WRITER_RULES;
    openSpaceMenu();

    expect(screen.getByRole("menuitem", { name: "Import pages" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Trash" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Export space" })).toBeNull();
    expect(screen.queryByTestId("export-modal")).toBeNull();
    expect(screen.getByTestId("import-modal")).toBeTruthy();
  });
});
