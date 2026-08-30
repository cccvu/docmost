import { describe, it, expect, beforeAll, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter } from "react-router-dom";
import { PublicAuthButtons } from "./public-auth-buttons";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

beforeAll(() => {
  // Mantine reads matchMedia; jsdom doesn't implement it.
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

function renderWithProviders(ui: React.ReactNode) {
  return render(
    <MantineProvider>
      <MemoryRouter>{ui}</MemoryRouter>
    </MantineProvider>,
  );
}

describe("PublicAuthButtons", () => {
  it("renders a Log in link and a Sign up link", () => {
    renderWithProviders(<PublicAuthButtons />);
    expect(screen.getByRole("link", { name: /log in/i })).toBeTruthy();
    const signup = screen.getByRole("link", { name: /sign up/i });
    expect(signup.getAttribute("href")).toBe("/request-access");
  });
});
