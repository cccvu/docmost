import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter } from "react-router-dom";

/**
 * THE OTP-RECOVERY invariant (issue #319 review).
 *
 * Every magic-link email also carries a 6-digit code, and that code is the documented recovery path
 * (ADR 0018) for a link whose fragment a mail rewriter dropped — it is the entire reason the cutover
 * to a fragment-only link was judged safe, and it is the email-independent leg of the
 * `admin:login-link` break-glass.
 *
 * It only works if the code field is reachable WITHOUT issuing a new token: issuing supersedes every
 * prior live token for the address (`issuePasswordlessToken` → `invalidateOutstanding`), so a UI whose
 * only route to the field is "request an email" destroys the code the user was told to type. This file
 * pins the reachable route. If someone deletes "I already have a code", these tests fail.
 */

const requestEmail = vi.fn(async () => true);
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
  usePasswordless: () => ({
    requestEmail,
    completeSignIn,
    isRequesting: false,
    isVerifying: false,
  }),
}));

import PasswordlessLogin from "./passwordless-login";

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

function renderLogin() {
  return render(
    <MantineProvider>
      <MemoryRouter initialEntries={["/login"]}>
        <PasswordlessLogin />
      </MemoryRouter>
    </MantineProvider>,
  );
}

function typeEmail(value = "user@vanderbilt.edu") {
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value } });
}

describe("PasswordlessLogin — the OTP is reachable without destroying it", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reaches the code field WITHOUT issuing a new token", async () => {
    renderLogin();
    typeEmail();
    fireEvent.click(
      screen.getByRole("button", { name: /i already have a code/i }),
    );

    await waitFor(() =>
      expect(screen.getByLabelText(/one-time code/i)).toBeTruthy(),
    );
    // The whole point: no issuance, so the code the user is holding is still live.
    expect(requestEmail).not.toHaveBeenCalled();
  });

  it("verifies the code the user already holds", async () => {
    renderLogin();
    typeEmail();
    fireEvent.click(
      screen.getByRole("button", { name: /i already have a code/i }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/one-time code/i)).toBeTruthy(),
    );

    for (const input of Array.from(
      document.querySelectorAll<HTMLInputElement>('input[inputmode="numeric"]'),
    ).slice(0, 6)) {
      fireEvent.change(input, { target: { value: "1" } });
    }
    fireEvent.click(screen.getByRole("button", { name: /sign in with code/i }));

    await waitFor(() => expect(completeSignIn).toHaveBeenCalledTimes(1));
    expect(completeSignIn).toHaveBeenCalledWith({
      email: "user@vanderbilt.edu",
      otp: "111111",
    });
    expect(requestEmail).not.toHaveBeenCalled();
  });

  it("does not offer the shortcut before an email address is entered", () => {
    renderLogin();
    // completeSignIn needs { email, otp } as a PAIR, so a code step with no address is a dead end.
    expect(
      screen
        .getByRole("button", { name: /i already have a code/i })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("still issues a token on the normal request path", async () => {
    renderLogin();
    typeEmail();
    fireEvent.click(
      screen.getByRole("button", { name: /email me a sign-in link and code/i }),
    );
    await waitFor(() => expect(requestEmail).toHaveBeenCalledTimes(1));
    expect(requestEmail).toHaveBeenCalledWith("user@vanderbilt.edu");
  });
});
