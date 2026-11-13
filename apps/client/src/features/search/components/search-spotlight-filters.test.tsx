// wiki-v2 UI cleanup: the search Type filter offers "Attachments" only when attachment indexing is
// entitled (it was a disabled option with an "Enterprise" badge), and the whole Type menu is hidden
// when "Pages" is the only option left. Mirrors export-modal.tsx's docx option.
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
import React from "react";

const entitled = vi.hoisted(() => ({ attachmentIndexing: false }));
vi.mock("@/ee/hooks/use-feature", () => ({
  useHasFeature: (feature: string) =>
    feature === "attachment:indexing" ? entitled.attachmentIndexing : false,
}));

vi.mock("@/features/space/queries/space-query", () => ({
  useGetSpacesQuery: () => ({ data: { items: [] } }),
}));
vi.mock("@/features/space/components/space-filter-menu", () => ({
  SpaceFilterMenu: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));
vi.mock("@/features/user/atoms/current-user-atom.ts", async () => {
  const { atom } = await import("jotai");
  return { workspaceAtom: atom({ settings: {} }) };
});
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { SearchSpotlightFilters } from "./search-spotlight-filters";

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
  entitled.attachmentIndexing = false;
});

afterEach(cleanup);

function renderFilters() {
  const onFiltersChange = vi.fn();
  render(
    <MantineProvider env="test">
      <SearchSpotlightFilters onFiltersChange={onFiltersChange} />
    </MantineProvider>,
  );
  return { onFiltersChange };
}

describe("SearchSpotlightFilters — Type filter", () => {
  it("not entitled: no Type menu, no Enterprise badge, and the search still filters on pages", () => {
    const { onFiltersChange } = renderFilters();

    expect(screen.queryByRole("button", { name: /^Type/ })).toBeNull();
    expect(screen.queryByText("Attachments")).toBeNull();
    expect(screen.queryByText("Enterprise")).toBeNull();
    // The space filter is unaffected.
    expect(screen.getByRole("button", { name: /Space/ })).toBeTruthy();
    // The hidden menu leaves the content type at its "page" default.
    expect(onFiltersChange).toHaveBeenCalledWith({
      spaceId: null,
      contentType: "page",
    });
  });

  it("entitled: the Type menu offers Pages and an enabled Attachments option", () => {
    entitled.attachmentIndexing = true;
    renderFilters();

    const typeButton = screen.getByRole("button", { name: /^Type: Pages/ });
    fireEvent.click(typeButton);

    const attachments = screen.getByRole("menuitemradio", {
      name: /Attachments/,
    });
    expect(attachments.hasAttribute("disabled")).toBe(false);
    expect(attachments.getAttribute("data-disabled")).toBeNull();
    expect(screen.getByRole("menuitemradio", { name: /Pages/ })).toBeTruthy();
    expect(screen.queryByText("Enterprise")).toBeNull();
  });
});
