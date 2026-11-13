import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter } from "react-router-dom";

// CCC (wiki-v2 UI cleanup): the AGPL §13 source link and the native-mode request-access gate.
const nativeState = vi.hoisted(() => ({ value: false }));
vi.mock("@/features/auth-native/lib/auth-mode.ts", () => ({
  isNativeAuthEnabled: () => nativeState.value,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock("@/features/brand/brand-hooks.ts", () => ({
  useBrandConfig: () => ({ name: "Wiki", institutionName: "" }),
}));

import { PublicFooter } from "./public-footer";

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

function renderFooter() {
  return render(
    <MantineProvider>
      <MemoryRouter>
        <PublicFooter year={2026} />
      </MemoryRouter>
    </MantineProvider>,
  );
}

describe("PublicFooter", () => {
  it("offers the Corresponding Source at the PUBLIC fork in both modes (AGPL §13)", () => {
    for (const native of [false, true]) {
      nativeState.value = native;
      const { unmount } = renderFooter();
      const source = screen.getByRole("link", { name: "Source" });
      expect(source.getAttribute("href")).toBe(
        "https://github.com/cccvu/docmost/tree/wiki-v2",
      );
      unmount();
    }
  });

  it("remote mode: shows Log in and Request access", () => {
    renderFooter();
    expect(screen.getByRole("link", { name: "Log in" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Request access" }).getAttribute("href"),
    ).toBe("/request-access");
  });

  it("native mode: hides Request access (it posts to the platform)", () => {
    nativeState.value = true;
    renderFooter();
    expect(screen.getByRole("link", { name: "Log in" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Request access" })).toBeNull();
  });
});
