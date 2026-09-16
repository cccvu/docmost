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

function typeEmail(value = "user@example.edu") {
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value } });
}

function fillOtp(digits = "111111") {
  const inputs = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[inputmode="numeric"]'),
  ).slice(0, 6);
  inputs.forEach((input, i) =>
    fireEvent.change(input, { target: { value: digits[i] } }),
  );
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

    fillOtp();
    fireEvent.click(screen.getByRole("button", { name: /sign in with code/i }));

    await waitFor(() => expect(completeSignIn).toHaveBeenCalledTimes(1));
    expect(completeSignIn).toHaveBeenCalledWith({
      email: "user@example.edu",
      otp: "111111",
    });
    expect(requestEmail).not.toHaveBeenCalled();
  });

  it("offers the shortcut even with no address typed, and collects it on the code step", async () => {
    // It used to be `disabled` until an address was entered. Mantine's Anchor has NO `:disabled` styling,
    // so that rendered as a live link that silently swallowed the click — and the user's next move is the
    // button that supersedes the code they came to redeem. The address is collected on the next step now.
    renderLogin();
    const shortcut = screen.getByRole("button", {
      name: /i already have a code/i,
    });
    expect(shortcut.hasAttribute("disabled")).toBe(false);

    fireEvent.click(shortcut);
    await waitFor(() =>
      expect(screen.getByLabelText(/one-time code/i)).toBeTruthy(),
    );
    // The pair is verified together, so the address must be visible and correctable here.
    expect(screen.getByLabelText(/email/i)).toBeTruthy();
    expect(requestEmail).not.toHaveBeenCalled();
  });

  it("will not submit a code without an address — the pair is verified together", async () => {
    renderLogin();
    fireEvent.click(
      screen.getByRole("button", { name: /i already have a code/i }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/one-time code/i)).toBeTruthy(),
    );
    fillOtp();
    fireEvent.click(screen.getByRole("button", { name: /sign in with code/i }));
    await new Promise((r) => setTimeout(r, 20));
    expect(completeSignIn).not.toHaveBeenCalled();
  });

  it("RETURNS to the email step via 'Use a different email'", async () => {
    // Drop `setHaveCode(false)` and this reds: the code step never closes, the email step never comes
    // back, and the only escape from the dead end is a reload.
    renderLogin();
    typeEmail();
    fireEvent.click(
      screen.getByRole("button", { name: /i already have a code/i }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/one-time code/i)).toBeTruthy(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /use a different email/i }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: /email me a sign-in link and code/i,
        }),
      ).toBeTruthy(),
    );
    expect(screen.queryByLabelText(/one-time code/i)).toBeNull();
  });

  it("CLEARS the stale code when a resend succeeds — the old one was just superseded", async () => {
    // Drop `setOtp("")` and this reds: the field still holds the code the resend just invalidated, so the
    // user submits it and is told their code is invalid moments after asking for a fresh one.
    renderLogin();
    typeEmail();
    fireEvent.click(
      screen.getByRole("button", { name: /i already have a code/i }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/one-time code/i)).toBeTruthy(),
    );
    fillOtp();
    fireEvent.click(screen.getByRole("button", { name: /resend email/i }));
    await waitFor(() => expect(requestEmail).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        Array.from(
          document.querySelectorAll<HTMLInputElement>(
            'input[inputmode="numeric"]',
          ),
        )
          .slice(0, 6)
          .every((i) => i.value === ""),
      ).toBe(true),
    );
  });

  it("does NOT claim an email was sent when the resend FAILS", async () => {
    // `requestEmail` resolves false rather than throwing, so an optimistic `setSent(true)` would flip the
    // copy to "Check your email" for a message that never went — the untruthful copy this page was fixed
    // to stop showing, reintroduced on the failure path.
    requestEmail.mockResolvedValueOnce(false);
    renderLogin();
    typeEmail();
    fireEvent.click(
      screen.getByRole("button", { name: /i already have a code/i }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/one-time code/i)).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: /resend email/i }));
    await waitFor(() => expect(requestEmail).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Check your email/i)).toBeNull();
  });

  it("still issues a token on the normal request path", async () => {
    renderLogin();
    typeEmail();
    fireEvent.click(
      screen.getByRole("button", { name: /email me a sign-in link and code/i }),
    );
    await waitFor(() => expect(requestEmail).toHaveBeenCalledTimes(1));
    expect(requestEmail).toHaveBeenCalledWith("user@example.edu");
  });
});
