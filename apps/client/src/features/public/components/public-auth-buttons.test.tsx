import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter } from "react-router-dom";

// CCC (wiki-v2 UI cleanup): request access is a platform flow, so native mode shows "Log in" only, and
// no button points at the page the visitor is on or at its sibling auth page.
const nativeState = vi.hoisted(() => ({ value: false }));
vi.mock("@/features/auth-native/lib/auth-mode.ts", () => ({
  isNativeAuthEnabled: () => nativeState.value,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { PublicAuthButtons } from "./public-auth-buttons";

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

beforeEach(() => {
  nativeState.value = false;
});

function renderWithProviders(ui: React.ReactNode, path = "/") {
  return render(
    <MantineProvider>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </MantineProvider>,
  );
}

describe("PublicAuthButtons", () => {
  it("remote mode: renders Log in and a Request access link to the request-access page", () => {
    renderWithProviders(<PublicAuthButtons />);
    expect(screen.getByRole("link", { name: /log in/i })).toBeTruthy();
    const request = screen.getByRole("link", { name: /request access/i });
    expect(request.getAttribute("href")).toBe("/request-access");
    // Renamed from upstream-style "Sign up": it files a request, it does not create an account.
    expect(screen.queryByRole("link", { name: /sign up/i })).toBeNull();
  });

  it("native mode: renders Log in only (no platform request-access flow)", () => {
    nativeState.value = true;
    renderWithProviders(<PublicAuthButtons />);
    expect(screen.getByRole("link", { name: /log in/i })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /request access/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /sign up/i })).toBeNull();
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  // The sign-in body already offers "Request access", so the header shows neither button there.
  it.each(["/login", "/login/verify"])(
    "remote mode on %s: renders neither Log in nor Request access",
    (path) => {
      renderWithProviders(<PublicAuthButtons />, path);
      expect(screen.queryByRole("link", { name: /log in/i })).toBeNull();
      expect(screen.queryByRole("link", { name: /request access/i })).toBeNull();
    },
  );

  it("native mode on /login: renders no Log in link to the page the visitor is on", () => {
    nativeState.value = true;
    renderWithProviders(<PublicAuthButtons />, "/login");
    expect(screen.queryByRole("link", { name: /log in/i })).toBeNull();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("remote mode on /request-access: renders Log in but not Request access", () => {
    renderWithProviders(<PublicAuthButtons />, "/request-access");
    expect(screen.getByRole("link", { name: /log in/i })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /request access/i })).toBeNull();
  });

  it("remote mode on a public share page: renders both buttons", () => {
    renderWithProviders(<PublicAuthButtons />, "/share/abc/p/some-page");
    expect(screen.getByRole("link", { name: /log in/i })).toBeTruthy();
    expect(screen.getByRole("link", { name: /request access/i })).toBeTruthy();
  });
});
