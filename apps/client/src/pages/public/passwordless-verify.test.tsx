import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter } from "react-router-dom";

/**
 * THE Safe-Links invariant guard (issue #4). The magic-link landing page must NEVER consume the token
 * on mount — VUIT Defender/Proofpoint executes landing-page JS, so an auto-submit would let a scanner
 * redeem the single-use token before the human (the sister-project's production token-burn incident).
 * If someone adds a `useEffect` that submits on mount, THIS test fails. Do not weaken it.
 */

const completeSignIn = vi.fn(async () => {});

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("react-helmet-async", () => ({ Helmet: () => null }));
vi.mock("@/features/public/components/public-shell.tsx", () => ({
  PublicShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/features/public/hooks/use-passwordless.ts", () => ({
  usePasswordless: () => ({ completeSignIn, isVerifying: false }),
}));

import PasswordlessVerify from "./passwordless-verify";

beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = ((q: string) => ({
      matches: false, media: q, onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
});

function renderAt(url: string) {
  return render(
    <MantineProvider>
      <MemoryRouter initialEntries={[url]}>
        <PasswordlessVerify />
      </MemoryRouter>
    </MantineProvider>,
  );
}

describe("PasswordlessVerify — no auto-submit (Safe-Links defense)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does NOT consume the token on mount", async () => {
    renderAt("/login/verify?token=raw-link-token");
    // Give any (forbidden) effect a chance to fire.
    await new Promise((r) => setTimeout(r, 20));
    expect(completeSignIn).not.toHaveBeenCalled();
    // The explicit affordance is present instead.
    expect(screen.getByRole("button", { name: /complete sign-in/i })).toBeTruthy();
  });

  it("consumes the token ONLY when the human clicks the button", async () => {
    renderAt("/login/verify?token=raw-link-token");
    fireEvent.click(screen.getByRole("button", { name: /complete sign-in/i }));
    await waitFor(() => expect(completeSignIn).toHaveBeenCalledWith({ token: "raw-link-token" }));
    expect(completeSignIn).toHaveBeenCalledTimes(1);
  });

  it("shows a 'link incomplete' notice and never consumes when the token is missing", async () => {
    renderAt("/login/verify");
    await new Promise((r) => setTimeout(r, 20));
    expect(completeSignIn).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /complete sign-in/i })).toBeNull();
  });
});
