import { describe, it, expect, beforeAll, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";

// CCC (wiki-v2 UI cleanup): the native sign-in page carries no "Set up your workspace" link.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock("react-helmet-async", () => ({ Helmet: () => null }));
vi.mock("@/features/public/components/public-shell", () => ({
  PublicShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/lib/config", () => ({ getAppName: () => "Wiki", isCloud: () => false }));
vi.mock("../hooks/use-native-login", () => ({
  useNativeLogin: () => ({ signIn: vi.fn(), isLoading: false }),
}));

import NativeLogin from "./native-login";

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

describe("NativeLogin", () => {
  it("renders the email/password form and no workspace-setup link", () => {
    render(
      <MantineProvider>
        <MemoryRouter>
          <NativeLogin />
        </MemoryRouter>
      </MantineProvider>,
    );
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.getByLabelText(/Email/)).toBeTruthy();
    expect(screen.queryByText("Set up your workspace")).toBeNull();
    expect(screen.queryByText(/First time here/)).toBeNull();
    expect(document.querySelector('a[href="/setup/register"]')).toBeNull();
  });
});
