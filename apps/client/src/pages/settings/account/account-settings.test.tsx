import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

// CCC (wiki-v2 UI cleanup): Email is native-only; Sessions show in both modes; the EE MFA section is never mounted.
const nativeState = vi.hoisted(() => ({ value: false }));
vi.mock("@/features/auth-native/lib/auth-mode.ts", () => ({
  isNativeAuthEnabled: () => nativeState.value,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock("react-helmet-async", () => ({ Helmet: () => null }));
vi.mock("@/lib/config.ts", () => ({ getAppName: () => "Wiki" }));
vi.mock("@/components/settings/settings-title.tsx", () => ({
  default: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
vi.mock("@/features/user/components/account-avatar", () => ({
  default: () => <div data-testid="avatar" />,
}));
vi.mock("@/features/user/components/account-name-form", () => ({
  default: () => <div data-testid="name" />,
}));
vi.mock("@/features/user/components/change-email", () => ({
  default: () => <div data-testid="change-email" />,
}));
vi.mock("@/features/session/components/session-list", () => ({
  default: () => <div data-testid="session-list" />,
}));
vi.mock("@/features/user/components/account-mfa-section", () => ({
  AccountMfaSection: () => <div data-testid="mfa" />,
}));

import AccountSettings from "./account-settings";

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

beforeEach(() => {
  nativeState.value = false;
});

function renderPage() {
  return render(
    <MantineProvider>
      <AccountSettings />
    </MantineProvider>,
  );
}

describe("AccountSettings", () => {
  it("remote mode: shows avatar, name and Sessions (no shadow email)", () => {
    renderPage();
    expect(screen.getByTestId("avatar")).toBeTruthy();
    expect(screen.getByTestId("name")).toBeTruthy();
    expect(screen.queryByTestId("change-email")).toBeNull();
    // "Log out of all devices" is the only self-service way to end other-device wiki sessions (ADR 0034).
    expect(screen.getByTestId("session-list")).toBeTruthy();
    expect(screen.queryByTestId("mfa")).toBeNull();
    expect(screen.queryAllByRole("separator")).toHaveLength(1);
  });

  it("native mode: also shows Email, Email and Sessions each after one divider", () => {
    nativeState.value = true;
    renderPage();
    expect(screen.getByTestId("avatar")).toBeTruthy();
    expect(screen.getByTestId("name")).toBeTruthy();
    expect(screen.getByTestId("change-email")).toBeTruthy();
    expect(screen.getByTestId("session-list")).toBeTruthy();
    expect(screen.queryByTestId("mfa")).toBeNull();
    expect(screen.queryAllByRole("separator")).toHaveLength(2);
  });
});
