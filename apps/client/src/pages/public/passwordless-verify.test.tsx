import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter, useNavigate } from "react-router-dom";

/**
 * THE Safe-Links invariant guard (issue #4). The magic-link landing page must NEVER consume the token
 * on mount — VUIT Defender/Proofpoint executes landing-page JS, so an auto-submit would let a scanner
 * redeem the single-use token before the human (the sister-project's production token-burn incident).
 * If someone adds a `useEffect` that submits on mount, THIS test fails. Do not weaken it.
 *
 * AND the fragment invariant (issue #319). The token arrives in the URL FRAGMENT, which the browser
 * never puts on the wire, because the ALB access log records the full request line with no redaction
 * available and lives in an AWS account shared with other VUIT projects. The last case below is the
 * one that matters: a `?token=` query string must be IGNORED, not honoured as a fallback — a fallback
 * would keep the leak alive for anyone who re-introduced the old URL shape. Do not weaken it either.
 */

const completeSignIn = vi.fn(async () => {});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock("react-helmet-async", () => ({ Helmet: () => null }));
vi.mock("@/features/public/components/public-shell.tsx", () => ({
  PublicShell: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("@/features/public/hooks/use-passwordless.ts", () => ({
  usePasswordless: () => ({ completeSignIn, isVerifying: false }),
}));

import PasswordlessVerify from "./passwordless-verify";

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

function renderAt(url: string) {
  return render(
    <MantineProvider>
      <MemoryRouter initialEntries={[url]}>
        <PasswordlessVerify />
      </MemoryRouter>
    </MantineProvider>,
  );
}

/**
 * Renders the page AND a control that navigates to another fragment on the SAME path. That is what a browser
 * does when a user opens a second sign-in email in a tab already sitting on this page: only the fragment
 * changes, so it is a same-document navigation and this component never remounts.
 */
function NavTo({ to }: { to: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(to)}>
      open another link
    </button>
  );
}

function renderWithFragmentNav(url: string, next: string) {
  return render(
    <MantineProvider>
      <MemoryRouter initialEntries={[url]}>
        <PasswordlessVerify />
        <NavTo to={next} />
      </MemoryRouter>
    </MantineProvider>,
  );
}

describe("PasswordlessVerify — no auto-submit (Safe-Links defense)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Tests below deliberately seed the real address bar; reset it so a fragment cannot leak sideways.
    window.history.replaceState(null, "", "/");
  });

  it("does NOT consume the token on mount", async () => {
    renderAt("/login/verify#token=raw-link-token");
    // Give any (forbidden) effect a chance to fire.
    await new Promise((r) => setTimeout(r, 20));
    expect(completeSignIn).not.toHaveBeenCalled();
    // The explicit affordance is present instead.
    expect(
      screen.getByRole("button", { name: /complete sign-in/i }),
    ).toBeTruthy();
  });

  it("consumes the token ONLY when the human clicks the button", async () => {
    renderAt("/login/verify#token=raw-link-token");
    fireEvent.click(screen.getByRole("button", { name: /complete sign-in/i }));
    await waitFor(() =>
      expect(completeSignIn).toHaveBeenCalledWith({ token: "raw-link-token" }),
    );
    expect(completeSignIn).toHaveBeenCalledTimes(1);
  });

  it("shows a 'link incomplete' notice and never consumes when the token is missing", async () => {
    renderAt("/login/verify");
    await new Promise((r) => setTimeout(r, 20));
    expect(completeSignIn).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /complete sign-in/i }),
    ).toBeNull();
  });
});

describe("PasswordlessVerify — the token comes from the FRAGMENT only (issue #319)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, "", "/");
  });

  it("IGNORES a ?token= query string — no query-string fallback exists", async () => {
    // Put the query on BOTH readable surfaces: the router entry (what `useSearchParams` /
    // `useLocation().search` see) and jsdom's own address bar (what `window.location.search` sees).
    // Either one alone leaves the other fallback shape undetected — a vacuous guard.
    window.history.replaceState(null, "", "/login/verify?token=raw-link-token");
    renderAt("/login/verify?token=raw-link-token");
    await new Promise((r) => setTimeout(r, 20));
    expect(completeSignIn).not.toHaveBeenCalled();
    // Same branch as a missing token: the notice, and no affordance to redeem.
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /complete sign-in/i }),
    ).toBeNull();
  });

  it("reads the token when a query string is ALSO present (fragment wins, query is inert)", async () => {
    renderAt("/login/verify?next=%2Fhome#token=raw-link-token");
    fireEvent.click(screen.getByRole("button", { name: /complete sign-in/i }));
    await waitFor(() =>
      expect(completeSignIn).toHaveBeenCalledWith({ token: "raw-link-token" }),
    );
  });

  it("re-reads the fragment on a SAME-DOCUMENT navigation (a second link opened in the same tab)", async () => {
    // Regression, found in a real browser: a first-render-only capture kept redeeming the FIRST token, so the
    // user got "invalid, expired, or already used" on a link that was none of those. A unit test that only
    // ever mounts the page cannot see this — the component is never remounted by a fragment change.
    renderWithFragmentNav(
      "/login/verify#token=first-token",
      "/login/verify#token=second-token",
    );
    fireEvent.click(screen.getByRole("button", { name: /open another link/i }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /complete sign-in/i }),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: /complete sign-in/i }));
    await waitFor(() =>
      expect(completeSignIn).toHaveBeenCalledWith({ token: "second-token" }),
    );
    expect(completeSignIn).toHaveBeenCalledTimes(1);
  });

  it("does NOT consume on a fragment navigation — only the click still redeems", async () => {
    // The re-read is an effect, and effects are exactly what the Safe-Links guard forbids submitting from.
    renderWithFragmentNav(
      "/login/verify#token=first-token",
      "/login/verify#token=second-token",
    );
    fireEvent.click(screen.getByRole("button", { name: /open another link/i }));
    await new Promise((r) => setTimeout(r, 20));
    expect(completeSignIn).not.toHaveBeenCalled();
  });

  it("drops the fragment from the address bar when the human redeems it", async () => {
    // SEED jsdom's REAL address bar first. Without this it is "/" with no fragment, so an implementation
    // mutated to write `window.location.href` straight back would ALSO produce a token-free, "#"-free
    // string and this test would pass while the fragment survived. It did exactly that until the seed was
    // added (#319 review) — the assertions below are only meaningful once the bar actually holds a token.
    window.history.replaceState(null, "", "/login/verify#token=raw-link-token");
    expect(window.location.hash).toBe("#token=raw-link-token");

    const replaceState = vi.spyOn(window.history, "replaceState");
    renderAt("/login/verify#token=raw-link-token");
    // Not on mount: until the click this URL is the only copy the user holds, and a reload must work.
    expect(replaceState).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /complete sign-in/i }));
    await waitFor(() => expect(completeSignIn).toHaveBeenCalledTimes(1));
    expect(replaceState).toHaveBeenCalled();
    const url = String(replaceState.mock.calls[0][2]);
    expect(url).not.toContain("token");
    expect(url).not.toContain("#");
    // Assert the OUTCOME, not just the argument we passed — this is what the user's browser ends up with.
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/login/verify");
    replaceState.mockRestore();
  });

  it("PUTS THE FRAGMENT BACK when the redeem fails — a failed attempt consumes nothing", async () => {
    // A 5xx or a dropped connection leaves the token LIVE. Stripping it at click time and not restoring
    // it would destroy the user's only copy, so a reload after a transient blip would say "Link
    // incomplete" about a perfectly good link. That worked before this PR; it must keep working.
    window.history.replaceState(null, "", "/login/verify#token=raw-link-token");
    completeSignIn.mockRejectedValueOnce(new Error("network"));

    renderAt("/login/verify#token=raw-link-token");
    fireEvent.click(screen.getByRole("button", { name: /complete sign-in/i }));
    await waitFor(() => expect(completeSignIn).toHaveBeenCalledTimes(1));

    await waitFor(() =>
      expect(window.location.hash).toBe("#token=raw-link-token"),
    );
    // ...and the page is still usable: the retry button is there, because `token` lives in React state.
    expect(
      screen.getByRole("button", { name: /complete sign-in/i }),
    ).toBeTruthy();
  });

  it("NEVER CLEARS a captured token when a later navigation has no fragment", async () => {
    // The re-read effect guards on `next &&` precisely so onComplete's own fragment blanking cannot race
    // it to zero. Drop that guard and this test fails: the button disappears mid-flow and the user is
    // told their link is incomplete while holding a live token.
    renderWithFragmentNav(
      "/login/verify#token=raw-link-token",
      "/login/verify",
    );
    fireEvent.click(screen.getByRole("button", { name: /open another link/i }));
    await new Promise((r) => setTimeout(r, 20));

    expect(screen.queryByText(/Link incomplete/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /complete sign-in/i }));
    await waitFor(() => expect(completeSignIn).toHaveBeenCalledTimes(1));
    expect(completeSignIn).toHaveBeenCalledWith({ token: "raw-link-token" });
  });
});
