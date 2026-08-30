import { describe, it, expect, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { Brand, INSTITUTION_NAME } from "./brand-logo";

// Mantine's color-scheme hooks read matchMedia; jsdom lacks it.
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

function renderBrand(ui: React.ReactNode) {
  return render(<MantineProvider>{ui}</MantineProvider>);
}

describe("Brand", () => {
  it("renders the lockup artwork and the app-name wordmark", () => {
    const { container } = renderBrand(<Brand variant="lockup" appName="CCC Wiki" />);
    expect(container.querySelector("img")).toBeTruthy();
    expect(screen.getByText("CCC Wiki")).toBeTruthy();
  });

  it("exposes the institution as accessible artwork alt when requested", () => {
    renderBrand(<Brand variant="lockup" alt={INSTITUTION_NAME} />);
    expect(screen.getByAltText(INSTITUTION_NAME)).toBeTruthy();
  });

  it("renders an icon-only mark with no wordmark", () => {
    const { container } = renderBrand(<Brand variant="icon" />);
    const imgs = container.querySelectorAll("img");
    expect(imgs.length).toBe(1);
    expect(screen.queryByText("CCC Wiki")).toBeNull();
  });

  it("keeps decorative artwork out of the accessibility tree by default", () => {
    const { container } = renderBrand(<Brand variant="lockup" appName="CCC Wiki" />);
    const img = container.querySelector("img");
    expect(img?.getAttribute("alt")).toBe("");
  });
});
