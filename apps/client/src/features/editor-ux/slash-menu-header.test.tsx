// #145: the slash menu's group header (the only group is `basic`) was rendered raw, so the visible text
// was "Basic" only through CSS capitalize and the role=group accessible name stayed lowercase "basic" in
// every language. Both now go through t() (en-US catalog: "basic" → "Basic"). Lives under the fork-owned
// editor-ux prefix so the test does not become a new upstream file beside command-list.tsx (seam #71).
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import type { SlashMenuGroupedItemsType } from "@/features/editor/components/slash-menu/types";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => `T:${key}` }),
}));
vi.mock("@/ee/hooks/use-feature", () => ({ useHasFeature: () => false }));

import CommandList from "@/features/editor/components/slash-menu/command-list";

// Mantine needs matchMedia + ResizeObserver in jsdom.
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
  // jsdom has no scrollIntoView; CommandList scrolls the selected row into view.
  Element.prototype.scrollIntoView ??= () => {};
});

afterEach(cleanup);

const items: SlashMenuGroupedItemsType = {
  basic: [
    {
      title: "Text",
      description: "Just start typing with plain text.",
      searchTerms: [],
      icon: () => null,
      command: () => {},
    },
  ],
};

describe("slash menu group header (#145)", () => {
  it("translates the group heading and its accessible name", () => {
    render(
      <MantineProvider>
        <CommandList items={items} command={() => {}} editor={null} range={null} />
      </MantineProvider>,
    );
    const group = screen.getByRole("group");
    expect(group.getAttribute("aria-label")).toBe("T:basic");
    expect(screen.getByText("T:basic")).toBeTruthy();
    expect(screen.queryByText("basic")).toBeNull();
  });
});
