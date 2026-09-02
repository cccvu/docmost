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
  it("renders the serif wordmark art, the college line, and the app-name wordmark", () => {
    const { container } = renderBrand(
      <Brand variant="lockup" appName="CCC Wiki" />,
    );
    // "Vanderbilt University" is inline vector artwork (SVG), not a font.
    expect(container.querySelector("svg")).toBeTruthy();
    // "College of Connected Computing" is live text (Inter sans).
    expect(screen.getByText("College of Connected Computing")).toBeTruthy();
    expect(screen.getByText("CCC Wiki")).toBeTruthy();
  });

  it("names the wordmark 'Vanderbilt University' by default", () => {
    const { container } = renderBrand(<Brand variant="lockup" />);
    const wordmark = container.querySelector('[role="img"]');
    expect(wordmark?.getAttribute("aria-label")).toBe("Vanderbilt University");
  });

  it("lets a caller override the wordmark's accessible name via alt", () => {
    const { container } = renderBrand(
      <Brand variant="lockup" alt={INSTITUTION_NAME} />,
    );
    const wordmark = container.querySelector('[role="img"]');
    expect(wordmark?.getAttribute("aria-label")).toBe(INSTITUTION_NAME);
  });

  it("renders an icon-only mark with no wordmark", () => {
    const { container } = renderBrand(<Brand variant="icon" />);
    const imgs = container.querySelectorAll("img");
    expect(imgs.length).toBe(1);
    expect(screen.queryByText("College of Connected Computing")).toBeNull();
  });
});
