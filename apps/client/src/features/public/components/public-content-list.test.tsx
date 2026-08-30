import { describe, it, expect, beforeAll, beforeEach, vi, type Mock } from "vitest";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter } from "react-router-dom";
import { PublicContentList } from "./public-content-list";
import { usePublicContentQuery } from "@/features/public/queries/public-query";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock("@/features/public/queries/public-query", () => ({
  usePublicContentQuery: vi.fn(),
}));

const mockQuery = usePublicContentQuery as unknown as Mock;

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
});

beforeEach(() => mockQuery.mockReset());

function renderList() {
  return render(
    <MantineProvider>
      <MemoryRouter>
        <PublicContentList />
      </MemoryRouter>
    </MantineProvider>,
  );
}

const item = {
  pageId: "p1",
  slugId: "handbook-1",
  title: "Public Handbook",
  icon: null,
  spaceName: "Docs",
  spaceSlug: "docs",
  shareKey: "abc123",
  createdAt: "2026-01-01",
  updatedAt: "2026-02-01",
};

describe("PublicContentList", () => {
  it("shows the section (no card links) while loading", () => {
    mockQuery.mockReturnValue({ isLoading: true, isError: false, data: undefined });
    renderList();
    expect(screen.getByText("Explore public pages")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders each public page as a link into its /share page", () => {
    mockQuery.mockReturnValue({ isLoading: false, isError: false, data: { items: [item], meta: {} } });
    renderList();
    const link = screen.getByRole("link", { name: /Public Handbook/i });
    expect(link.getAttribute("href")).toBe("/share/abc123/p/handbook-1");
  });

  it("shows an empty state when nothing is published", () => {
    mockQuery.mockReturnValue({ isLoading: false, isError: false, data: { items: [], meta: {} } });
    renderList();
    expect(
      screen.getByText(/No public pages have been published yet/i),
    ).toBeTruthy();
  });

  it("hides the whole section on error (enhancement, non-blocking)", () => {
    mockQuery.mockReturnValue({ isLoading: false, isError: true, data: undefined });
    renderList();
    expect(screen.queryByText("Explore public pages")).toBeNull();
  });
});
