import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { Brand } from "./brand-logo";
import { NEUTRAL_BRAND, setBrandConfigForTest } from "./brand-config";

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

afterEach(() => {
  setBrandConfigForTest(NEUTRAL_BRAND);
});

const BRANDED = {
  name: "Example Wiki",
  institutionName: "Example University",
  collegeName: "Example College",
  assets: {
    icon: "/brand/v-icon.png",
    wordmarkSvg: "/brand/wordmark.svg",
  },
  wordmarkSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
};

function renderBrand(ui: React.ReactNode) {
  return render(<MantineProvider>{ui}</MantineProvider>);
}

describe("Brand with a runtime brand bundle", () => {
  it("renders the icon, the inline wordmark art, the college line, and the app name", () => {
    setBrandConfigForTest(BRANDED);
    const { container } = renderBrand(
      <Brand variant="lockup" appName="Example Wiki" />,
    );
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(container.querySelector("svg")).toBeTruthy();
    expect(screen.getByText("Example College")).toBeTruthy();
    expect(screen.getByText("Example Wiki")).toBeTruthy();
  });

  it("names the wordmark with the institution name by default", () => {
    setBrandConfigForTest(BRANDED);
    const { container } = renderBrand(<Brand variant="lockup" />);
    const wordmark = container.querySelector('[role="img"]');
    expect(wordmark?.getAttribute("aria-label")).toBe("Example University");
  });

  it("lets a caller override the wordmark's accessible name via alt", () => {
    setBrandConfigForTest(BRANDED);
    const { container } = renderBrand(<Brand variant="lockup" alt="CCC" />);
    const wordmark = container.querySelector('[role="img"]');
    expect(wordmark?.getAttribute("aria-label")).toBe("CCC");
  });

  it("renders an icon-only mark with no wordmark", () => {
    setBrandConfigForTest(BRANDED);
    const { container } = renderBrand(<Brand variant="icon" />);
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(screen.queryByText("Example College")).toBeNull();
  });
});

describe("Brand without a runtime bundle", () => {
  it("renders the app name as plain text and no artwork", () => {
    const { container } = renderBrand(
      <Brand variant="lockup" appName="Example Wiki" />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.getByText("Example Wiki")).toBeTruthy();
  });

  it("falls back to the neutral app name when the caller passes none", () => {
    renderBrand(<Brand variant="lockup" />);
    expect(screen.getByText("Wiki")).toBeTruthy();
  });

  it("renders nothing for the icon variant", () => {
    const { container } = renderBrand(<Brand variant="icon" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
  });
});
