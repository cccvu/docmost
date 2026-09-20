import { describe, it, expect, beforeAll, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Container, MantineProvider } from "@mantine/core";
import { MemoryRouter } from "react-router-dom";

/**
 * Landmark regression for the public shell (GitHub #29) — NOT upstream Docmost code.
 *
 * The footer must be a page-level `contentinfo` landmark, i.e. rendered OUTSIDE <main>. Passing it via
 * PublicShell's `footer` slot (a sibling of AppShell.Main) is what makes that true; a <footer> nested
 * inside <main> is exposed as a generic element instead. This pins the structure.
 */

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock("@/features/workspace/queries/workspace-query.ts", () => ({
  useWorkspacePublicDataQuery: () => ({ data: undefined }),
}));
vi.mock("@/components/theme-toggle.tsx", () => ({ ThemeToggle: () => null }));
vi.mock("@/components/ui/skip-to-main.tsx", () => ({
  SkipToMain: () => null,
  MAIN_CONTENT_ID: "main-content",
}));
vi.mock("@/features/brand/brand-logo.tsx", () => ({ Brand: () => null }));
vi.mock("./public-auth-buttons.tsx", () => ({ PublicAuthButtons: () => null }));
vi.mock("@/lib/config.ts", () => ({ getAppName: () => "Wiki" }));
vi.mock("@/features/layout/layout-tokens.ts", () => ({ HEADER_HEIGHT: 60 }));

import { PublicShell } from "./public-shell";

beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
});

function renderShell() {
  return render(
    <MantineProvider>
      <MemoryRouter>
        <PublicShell
          footer={<Container component="footer">© 2026 Wiki</Container>}
        >
          <p>body content</p>
        </PublicShell>
      </MemoryRouter>
    </MantineProvider>,
  );
}

describe("PublicShell — footer is a contentinfo landmark (#29)", () => {
  it("exposes the footer slot as a `contentinfo` landmark rendered OUTSIDE <main>", () => {
    renderShell();
    const footer = screen.getByRole("contentinfo");
    expect(footer.textContent).toContain("© 2026 Wiki");
    const main = document.querySelector("main");
    expect(main).not.toBeNull();
    // the landmark must NOT be nested inside <main> (that would demote it to a generic element)
    expect(main?.contains(footer)).toBe(false);
  });
});
