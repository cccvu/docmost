import {
  describe,
  it,
  expect,
  afterEach,
  beforeAll,
  beforeEach,
  vi,
} from "vitest";
import {
  act,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter } from "react-router-dom";

/**
 * THE OTP-RECOVERY invariant (issue #319 review).
 *
 * Every magic-link email also carries a one-time code, and that code is the documented recovery path
 * (ADR 0018) for a link whose fragment a mail rewriter dropped — it is the entire reason the cutover
 * to a fragment-only link was judged safe, and it is the email-independent leg of the
 * `admin:login-link` break-glass.
 *
 * It only works if the code field is reachable WITHOUT issuing a new token: issuing supersedes every
 * prior live token for the address (`issuePasswordlessToken` → `invalidateOutstanding`), so a UI whose
 * only route to the field is "request an email" destroys the code the user was told to type. This file
 * pins the reachable route. If someone deletes "I already have a code", these tests fail.
 */

const requestEmail = vi.fn(
  async (
    _email: string,
    _opts?: { onRetryAfter?: (seconds: number) => void },
  ): Promise<boolean> => true,
);
const completeSignIn = vi.fn(
  async (_args: unknown, _opts?: { screens?: boolean }) => {},
);
// The #818 pluggable verifier: like the real hook, it calls the verifier BEFORE its first await (the gesture rule).
const completeSignInWith = vi.fn(
  async (
    verify: () => Promise<unknown>,
    _opts: { method: "email" | "passkey"; screens?: boolean },
  ) => {
    await verify();
  },
);
const continueAfterSignIn = vi.fn();
const showNotification = vi.fn();

// #818 passkey seams. Passkeys are OFF unless a test turns them on (jsdom has no WebAuthn either), so every pre-#818
// test above sees the page exactly as before.
const pk = vi.hoisted(() => ({
  supported: false,
  postSignIn: null as
    | null
    | { kind: "nudge" }
    | { kind: "reminder"; daysLeft: number },
  signIn: vi.fn(async (): Promise<unknown> => ({})),
  disarm: vi.fn(),
  arm: vi.fn(),
  handlers: null as null | {
    onSignedIn: (r: unknown) => void;
    onFailure: (f: unknown) => void;
  },
}));
vi.mock("@/features/passkeys/lib/capabilities.ts", () => ({
  passkeysSupported: () => pk.supported,
}));
vi.mock("@/features/passkeys/lib/autofill.ts", () => ({
  armPasskeyAutofill: (h: {
    onSignedIn: (r: unknown) => void;
    onFailure: (f: unknown) => void;
  }) => {
    pk.arm(h);
    pk.handlers = h;
    return pk.disarm;
  },
}));
vi.mock("@/features/passkeys/services/passkey-api.ts", () => ({
  signInWithPasskey: (...a: unknown[]) => pk.signIn(...(a as [])),
}));
vi.mock("@/features/passkeys/components/passkey-nudge.tsx", () => ({
  PasskeyNudge: ({ onDone }: { onDone: () => void }) => (
    <button onClick={onDone}>nudge-stub</button>
  ),
}));
vi.mock("@/features/passkeys/components/passkey-reminder.tsx", () => ({
  PasskeyReminder: ({
    daysLeft,
    onDone,
  }: {
    daysLeft: number;
    onDone: () => void;
  }) => <button onClick={onDone}>reminder-stub {daysLeft}</button>,
}));

vi.mock("@mantine/notifications", () => ({
  notifications: { show: (...a: unknown[]) => showNotification(...a) },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    // Interpolates like i18next does for a key with no translation (the key is the English text).
    t: (k: string, o?: Record<string, unknown>) =>
      k.replace(/{{(\w+)}}/g, (_: string, n: string) => String(o?.[n])),
  }),
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
    completeSignInWith,
    continueAfterSignIn,
    postSignIn: pk.postSignIn,
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

function otpField() {
  return screen.getByLabelText(/one-time code/i) as HTMLInputElement;
}

// Typing: one `insertText` input event per character, as a keyboard produces. Never auto-submits (#815).
function typeOtp(text = "111111") {
  const field = otpField();
  for (const ch of text) {
    fireEvent.input(field, {
      target: { value: field.value + ch },
      inputType: "insertText",
      data: ch,
    });
  }
}

// A paste: the whole text lands in ONE input event of type `insertFromPaste` (replacing what was there, as a
// select-all paste does).
function pasteOtp(text: string) {
  fireEvent.input(otpField(), {
    target: { value: text },
    inputType: "insertFromPaste",
    data: text,
  });
}

function http(status: number, headers: Record<string, string> = {}) {
  return Object.assign(new Error(`HTTP ${status}`), {
    isAxiosError: true,
    response: { status, headers, data: {} },
  });
}

async function openCodeStep(withEmail = true) {
  renderLogin();
  if (withEmail) typeEmail();
  fireEvent.click(
    screen.getByRole("button", { name: /i already have a code/i }),
  );
  await waitFor(() => expect(otpField()).toBeTruthy());
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

    typeOtp();
    fireEvent.click(screen.getByRole("button", { name: /sign in with code/i }));

    await waitFor(() => expect(completeSignIn).toHaveBeenCalledTimes(1));
    expect(completeSignIn).toHaveBeenCalledWith(
      {
        email: "user@example.edu",
        otp: "111111",
      },
      { screens: true },
    );
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

  // The previous version of this test asserted only that nothing happened, and was satisfied by the HTML
  // `required` attribute rather than by either guard it named: deleting `!email.trim()` from the button's
  // `disabled`, from the `onVerify` guard, or from BOTH left it green. A "did not happen" assertion with
  // no positive control on the same path is exactly how that drifts. These two pin each guard directly and
  // each carries its own positive control.

  it("DISABLES the submit button until both an address and a full code are present", async () => {
    renderLogin();
    fireEvent.click(
      screen.getByRole("button", { name: /i already have a code/i }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/one-time code/i)).toBeTruthy(),
    );
    const submit = screen.getByRole("button", { name: /sign in with code/i });

    typeOtp();
    // A full code but no address: the button must still be out of reach.
    expect(submit.hasAttribute("disabled")).toBe(true);

    // POSITIVE CONTROL on the same path — with the address supplied it must become reachable, otherwise
    // the assertion above would pass against a button that is simply always disabled.
    typeEmail();
    await waitFor(() => expect(submit.hasAttribute("disabled")).toBe(false));
  });

  it("onVerify itself refuses a blank address, independently of the button and of `required`", async () => {
    renderLogin();
    fireEvent.click(
      screen.getByRole("button", { name: /i already have a code/i }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/one-time code/i)).toBeTruthy(),
    );
    typeOtp();

    // Submitting the FORM directly bypasses both the disabled button and native `required` validation,
    // so what is left is the guard inside onVerify — and nothing else.
    const form = document.querySelector("form") as HTMLFormElement;
    fireEvent.submit(form);
    await new Promise((r) => setTimeout(r, 20));
    expect(completeSignIn).not.toHaveBeenCalled();

    // POSITIVE CONTROL: the same direct submit must go through once an address is present, proving the
    // refusal above came from the guard rather than from the submit never reaching the handler.
    typeEmail();
    fireEvent.submit(form);
    await waitFor(() => expect(completeSignIn).toHaveBeenCalledTimes(1));
  });

  it("FOCUSES the empty address field when arriving without one", async () => {
    // Focus has to follow the field that is actually empty. If it stays on the PinInput, mount focus
    // skips the address entirely — and since Mantine renders the submit button's `disabled` as the
    // native attribute, that button leaves the tab order, so one Tab from the last code cell lands on
    // "Resend email", whose Enter supersedes the code the user just typed.
    renderLogin();
    fireEvent.click(
      screen.getByRole("button", { name: /i already have a code/i }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/one-time code/i)).toBeTruthy(),
    );
    expect(document.activeElement).toBe(screen.getByLabelText(/email/i));

    // In this exact state, "Resend email" must also be out of reach: firing requestEmail("") surfaces
    // the catch-all "we couldn't send" toast, blaming a transient outage for the empty field above it.
    expect(
      screen
        .getByRole("button", { name: /resend email/i })
        .hasAttribute("disabled"),
    ).toBe(true);
    // Positive control — it comes back once there is an address to resend to.
    typeEmail();
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: /resend email/i })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
  });

  it("FOCUSES the code field when we just sent the email", async () => {
    // Positive control for the pair: on this path the address is already known, so the code is the
    // empty field and focus belongs there. Without this, `autoFocus={false}` on both would pass above.
    renderLogin();
    typeEmail();
    fireEvent.click(
      screen.getByRole("button", { name: /email me a sign-in code/i }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/one-time code/i)).toBeTruthy(),
    );
    expect(document.activeElement).toBe(otpField());
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
          name: /email me a sign-in code/i,
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
    typeOtp();
    fireEvent.click(screen.getByRole("button", { name: /resend email/i }));
    await waitFor(() => expect(requestEmail).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(otpField().value).toBe(""));
    // ...and the copy flips to the sent wording, which is the other half of `setSent(true)`. Without
    // this the success branch was unasserted in either direction: dropping it left the suite green.
    await waitFor(() =>
      expect(screen.getByText(/Check your email/i)).toBeTruthy(),
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
      screen.getByRole("button", { name: /email me a sign-in code/i }),
    );
    await waitFor(() => expect(requestEmail).toHaveBeenCalledTimes(1));
    expect(requestEmail).toHaveBeenCalledWith("user@example.edu", {
      onRetryAfter: expect.any(Function),
    });
  });
});

/**
 * #815 — ONE code field for a 6- or 8-digit code (the platform moves to 8 one release after this ships). It takes 6 to
 * 12 digits with spaces and hyphens ignored; a paste or autofill of a whole code submits it once; typing never does.
 */
describe("PasswordlessLogin — the code field takes 6 to 12 digits (#815)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("a pasted grouped 8-digit code ('1234 5678') submits itself, separators stripped", async () => {
    await openCodeStep();
    pasteOtp("1234 5678");
    await waitFor(() => expect(completeSignIn).toHaveBeenCalledTimes(1));
    expect(completeSignIn).toHaveBeenCalledWith(
      {
        email: "user@example.edu",
        otp: "12345678",
      },
      { screens: true },
    );
    // One field, not a row of cells: the whole code is in it.
    expect(otpField().value).toBe("1234 5678");
  });

  it("a pasted 6-digit code submits itself too (the length today)", async () => {
    await openCodeStep();
    pasteOtp("123456");
    await waitFor(() => expect(completeSignIn).toHaveBeenCalledTimes(1));
    expect(completeSignIn).toHaveBeenCalledWith(
      {
        email: "user@example.edu",
        otp: "123456",
      },
      { screens: true },
    );
  });

  it("an autofill that reports no input type still submits (the length jump is the tell)", async () => {
    await openCodeStep();
    fireEvent.change(otpField(), { target: { value: "87654321" } });
    await waitFor(() => expect(completeSignIn).toHaveBeenCalledTimes(1));
    expect(completeSignIn).toHaveBeenCalledWith(
      {
        email: "user@example.edu",
        otp: "87654321",
      },
      { screens: true },
    );
  });

  it("auto-submits ONCE: pasting the same code again does not submit it again", async () => {
    await openCodeStep();
    pasteOtp("1234 5678");
    await waitFor(() => expect(completeSignIn).toHaveBeenCalledTimes(1));
    pasteOtp("12345678");
    await new Promise((r) => setTimeout(r, 20));
    expect(completeSignIn).toHaveBeenCalledTimes(1);
    // ...but the button still works for a deliberate retry.
    fireEvent.click(screen.getByRole("button", { name: /sign in with code/i }));
    await waitFor(() => expect(completeSignIn).toHaveBeenCalledTimes(2));
  });

  it("TYPING a full code never submits it; the person presses the button", async () => {
    await openCodeStep();
    const submit = screen.getByRole("button", { name: /sign in with code/i });
    typeOtp("12345");
    // Five digits: not yet.
    expect(submit.hasAttribute("disabled")).toBe(true);
    typeOtp("678");
    await new Promise((r) => setTimeout(r, 20));
    expect(completeSignIn).not.toHaveBeenCalled();
    // Six or more digits: the button is offered (positive control for the wait above).
    await waitFor(() => expect(submit.hasAttribute("disabled")).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(completeSignIn).toHaveBeenCalledTimes(1));
    expect(completeSignIn).toHaveBeenCalledWith(
      {
        email: "user@example.edu",
        otp: "12345678",
      },
      { screens: true },
    );
  });

  it("a typed hyphen is ignored on submit", async () => {
    await openCodeStep();
    typeOtp("1234-5678");
    fireEvent.click(screen.getByRole("button", { name: /sign in with code/i }));
    await waitFor(() => expect(completeSignIn).toHaveBeenCalledTimes(1));
    expect(completeSignIn).toHaveBeenCalledWith(
      {
        email: "user@example.edu",
        otp: "12345678",
      },
      { screens: true },
    );
  });

  it("a paste with no address yet does not submit; the button does once the address is in", async () => {
    await openCodeStep(false);
    pasteOtp("1234 5678");
    await new Promise((r) => setTimeout(r, 20));
    expect(completeSignIn).not.toHaveBeenCalled();
    typeEmail();
    fireEvent.click(screen.getByRole("button", { name: /sign in with code/i }));
    await waitFor(() => expect(completeSignIn).toHaveBeenCalledTimes(1));
  });

  it("a malformed code is explained in an announced error, and not sent", async () => {
    await openCodeStep();
    typeOtp("1234567890123"); // 13 digits
    fireEvent.click(screen.getByRole("button", { name: /sign in with code/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "Enter the code from your email. It is 6 to 12 digits.",
    );
    expect(completeSignIn).not.toHaveBeenCalled();
    expect(otpField().getAttribute("aria-invalid")).toBe("true");
  });

  it("a wrong code is announced on the field and the field is cleared", async () => {
    completeSignIn.mockRejectedValueOnce(http(401));
    await openCodeStep();
    pasteOtp("1234 5678");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/invalid, expired, or already used/);
    expect(otpField().value).toBe("");
    expect(document.activeElement).toBe(otpField());
  });

  it("a 429 says to wait (Retry-After honored) and KEEPS the code", async () => {
    completeSignIn.mockRejectedValueOnce(http(429, { "retry-after": "120" }));
    await openCodeStep();
    pasteOtp("1234 5678");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "Too many requests. Wait 2 minutes, then try again.",
    );
    expect(otpField().value).toBe("1234 5678");
  });

  it("a 429 with no Retry-After says 'a few minutes'", async () => {
    completeSignIn.mockRejectedValueOnce(http(429));
    await openCodeStep();
    typeOtp("12345678");
    fireEvent.click(screen.getByRole("button", { name: /sign in with code/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "Too many requests. Wait a few minutes, then try again.",
    );
  });

  it("the field is one numeric one-time-code text field", async () => {
    await openCodeStep();
    const field = otpField();
    expect(field.getAttribute("inputmode")).toBe("numeric");
    expect(field.getAttribute("autocomplete")).toBe("one-time-code");
    expect(field.type).toBe("text"); // never type="number": that drops a leading zero and refuses a space
    expect(
      document.querySelectorAll('input[autocomplete="one-time-code"]'),
    ).toHaveLength(1);
  });

  it("after a send: the Junk hint shows; it does not when nothing was sent", async () => {
    await openCodeStep();
    expect(screen.queryByText(/Check your Junk or Clutter folder/)).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: /use a different email/i }),
    );
    typeEmail();
    fireEvent.click(
      screen.getByRole("button", { name: /email me a sign-in code/i }),
    );
    expect(
      await screen.findByText(
        "Can't find it? Check your Junk or Clutter folder.",
      ),
    ).toBeTruthy();
  });
});

describe("PasswordlessLogin — the 60 s resend countdown (#815)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("holds Resend for 60 s after a send, then offers it again", async () => {
    renderLogin();
    typeEmail();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /email me a sign-in code/i }),
      );
    });
    expect(requestEmail).toHaveBeenCalledTimes(1);
    const resend = () => screen.getByRole("button", { name: /resend email/i });
    expect(resend().textContent).toBe("Resend email (60s)");
    expect(resend().hasAttribute("disabled")).toBe(true);

    for (let i = 0; i < 30; i++) {
      act(() => {
        vi.advanceTimersByTime(1000);
      });
    }
    expect(resend().textContent).toBe("Resend email (30s)");
    expect(resend().hasAttribute("disabled")).toBe(true);

    for (let i = 0; i < 30; i++) {
      act(() => {
        vi.advanceTimersByTime(1000);
      });
    }
    expect(resend().textContent).toBe("Resend email");
    expect(resend().hasAttribute("disabled")).toBe(false);

    // A resend restarts the countdown.
    await act(async () => {
      fireEvent.click(resend());
    });
    expect(requestEmail).toHaveBeenCalledTimes(2);
    expect(resend().textContent).toBe("Resend email (60s)");
  });

  it("a FAILED send starts no countdown", async () => {
    renderLogin();
    typeEmail();
    fireEvent.click(
      screen.getByRole("button", { name: /i already have a code/i }),
    );
    requestEmail.mockResolvedValueOnce(false);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /resend email/i }));
    });
    expect(requestEmail).toHaveBeenCalledTimes(1);
    const resend = screen.getByRole("button", { name: /resend email/i });
    expect(resend.textContent).toBe("Resend email");
    expect(resend.hasAttribute("disabled")).toBe(false);
  });

  it("a throttled send that names its wait (Retry-After) holds Resend for that wait", async () => {
    renderLogin();
    typeEmail();
    fireEvent.click(
      screen.getByRole("button", { name: /i already have a code/i }),
    );
    requestEmail.mockImplementationOnce(async (_email, opts) => {
      opts?.onRetryAfter?.(120);
      return false;
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /resend email/i }));
    });
    const resend = screen.getByRole("button", { name: /resend email/i });
    expect(resend.textContent).toBe("Resend email (120s)");
    expect(resend.hasAttribute("disabled")).toBe(true);
  });
});

describe("PasswordlessLogin — verify failures (#815)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("a bridge failure is a toast, not a code error: the field keeps the code and shows no alert", async () => {
    // The code WAS good (the platform session was minted); only the wiki session bridge failed. Telling the
    // person the code is invalid, and clearing it, would send them to request a new one for nothing.
    completeSignIn.mockRejectedValueOnce(
      Object.assign(new Error("session-bridge-failed"), { stage: "bridge" }),
    );
    await openCodeStep();
    pasteOtp("1234 5678");
    await waitFor(() => expect(showNotification).toHaveBeenCalledTimes(1));
    expect(showNotification.mock.calls[0][0]).toMatchObject({
      message:
        "You're verified, but we couldn't open your workspace session. Please try again.",
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(otpField().value).toBe("1234 5678");
  });

  it("after a 429 the kept code is SELECTED, so a pasted fresh code replaces it instead of appending", async () => {
    completeSignIn.mockRejectedValueOnce(http(429));
    await openCodeStep();
    pasteOtp("123456");
    await screen.findByRole("alert");
    const field = otpField();
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(field.value.length);
  });
});

// #818 passkeys on the login page: autofill arm/abort, a button on each step that runs ONE ceremony from its click,
// the error table in ONE polite live region, email_confirmation_required → the code step, and the post-sign-in screens.
describe("PasswordlessLogin — passkeys (#818)", () => {
  // Real error helpers: the page feeds whatever the api throws to the real #818 table.
  let PasskeyErrorCtor: typeof import("@/features/passkeys/lib/passkey-errors.ts").PasskeyError;
  let httpFailureFn: typeof import("@/features/passkeys/lib/passkey-errors.ts").httpFailure;
  beforeAll(async () => {
    const mod = await import("@/features/passkeys/lib/passkey-errors.ts");
    PasskeyErrorCtor = mod.PasskeyError;
    httpFailureFn = mod.httpFailure;
  });
  const refused = (
    status: number,
    body: Record<string, unknown> = {},
    stage: "options" | "request" = "request",
  ) => new PasskeyErrorCtor(httpFailureFn(stage, status, body, null));

  beforeEach(() => {
    vi.clearAllMocks();
    pk.supported = true;
    pk.postSignIn = null;
    pk.handlers = null;
    pk.signIn.mockImplementation(async () => ({
      id: "i",
      email: "a@b.test",
      workspaceId: "w",
    }));
  });
  afterEach(() => {
    pk.supported = false;
    pk.postSignIn = null;
  });

  const passkeyButton = () =>
    screen.getByRole("button", { name: /^sign in with a passkey$/i });
  const liveRegion = () => {
    const region = document.querySelector(
      '[role="status"][aria-live="polite"]',
    );
    expect(region).toBeTruthy();
    return region as HTMLElement;
  };

  it("step 1's email field offers passkeys in its suggestions (username webauthn)", () => {
    renderLogin();
    expect(
      (screen.getByLabelText(/email/i) as HTMLInputElement).getAttribute(
        "autocomplete",
      ),
    ).toBe("username webauthn");
  });

  it("arms autofill once on step 1, and aborts it when the step changes", async () => {
    renderLogin();
    await waitFor(() => expect(pk.arm).toHaveBeenCalledTimes(1));
    expect(pk.disarm).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: /i already have a code/i }),
    );
    await waitFor(() => expect(otpField()).toBeTruthy());
    expect(pk.disarm).toHaveBeenCalled();
    expect(pk.arm).toHaveBeenCalledTimes(1); // never re-armed on the code step
  });

  it("aborts autofill on unmount", async () => {
    const view = renderLogin();
    await waitFor(() => expect(pk.arm).toHaveBeenCalledTimes(1));
    view.unmount();
    expect(pk.disarm).toHaveBeenCalled();
  });

  it("no WebAuthn in this browser: no passkey button, no autofill, email unchanged", () => {
    pk.supported = false;
    renderLogin();
    expect(screen.queryByRole("button", { name: /passkey/i })).toBeNull();
    expect(pk.arm).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /email me a sign-in code/i }),
    ).toBeTruthy();
  });

  it("the step-1 button aborts autofill FIRST, then starts its ceremony synchronously inside the click", async () => {
    renderLogin();
    await waitFor(() => expect(pk.arm).toHaveBeenCalledTimes(1));
    fireEvent.click(passkeyButton());
    // No waitFor: the verifier (one native fetch, then get()) must already have started within the click.
    expect(pk.signIn).toHaveBeenCalledTimes(1);
    expect(pk.disarm.mock.invocationCallOrder[0]).toBeLessThan(
      pk.signIn.mock.invocationCallOrder[0],
    );
    expect(completeSignInWith).toHaveBeenCalledWith(expect.any(Function), {
      method: "passkey",
      screens: true,
    });
  });

  it("the code step offers 'Didn't get a code? Sign in with a passkey', which runs the ceremony", async () => {
    await openCodeStep();
    fireEvent.click(
      screen.getByRole("button", {
        name: /didn't get a code\? sign in with a passkey/i,
      }),
    );
    expect(pk.signIn).toHaveBeenCalledTimes(1);
  });

  it("401 passkey_failed → a polite message with 'Try again' and 'Email me a code instead'; Try again is a new ceremony", async () => {
    pk.signIn.mockRejectedValueOnce(refused(401, { code: "passkey_failed" }));
    renderLogin();
    fireEvent.click(passkeyButton());
    await waitFor(() =>
      expect(liveRegion().textContent).toBe(
        "We couldn't sign you in with that passkey.",
      ),
    );
    expect(screen.queryByRole("alert")).toBeNull(); // polite, never an alert
    fireEvent.click(screen.getByRole("button", { name: /^try again$/i }));
    expect(pk.signIn).toHaveBeenCalledTimes(2);
  });

  it("401 passkey_not_recognized → says so and offers email, but no 'Try again'", async () => {
    pk.signIn.mockRejectedValueOnce(
      refused(401, { code: "passkey_not_recognized" }),
    );
    renderLogin();
    fireEvent.click(passkeyButton());
    await waitFor(() =>
      expect(liveRegion().textContent).toBe(
        "That passkey isn't set up for this account anymore.",
      ),
    );
    expect(
      screen.getByRole("button", { name: /email me a code instead/i }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^try again$/i })).toBeNull();
  });

  it("a cancelled prompt (NotAllowedError) shows nothing and leaves the button enabled", async () => {
    pk.signIn.mockRejectedValueOnce(
      new PasskeyErrorCtor({ kind: "cancelled" }),
    );
    renderLogin();
    fireEvent.click(passkeyButton());
    await waitFor(() => expect(completeSignInWith).toHaveBeenCalled());
    await act(async () => {});
    expect(liveRegion().textContent).toBe("");
    expect(passkeyButton().hasAttribute("disabled")).toBe(false);
  });

  it("an older platform (404 on options) hides every passkey control; email unchanged", async () => {
    pk.signIn.mockRejectedValueOnce(refused(404, {}, "options"));
    renderLogin();
    fireEvent.click(passkeyButton());
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /passkey/i })).toBeNull(),
    );
    expect(liveRegion().textContent).toMatch(/use an emailed code/i);
    expect(
      screen.getByRole("button", { name: /email me a sign-in code/i }),
    ).toBeTruthy();
  });

  it("403 email_confirmation_required → the code step for the address the platform named, and a code is mailed", async () => {
    pk.signIn.mockRejectedValueOnce(
      refused(403, {
        code: "email_confirmation_required",
        email: "owner@example.edu",
      }),
    );
    renderLogin();
    typeEmail("someone-else@example.edu");
    fireEvent.click(passkeyButton());
    await waitFor(() =>
      expect(requestEmail).toHaveBeenCalledWith(
        "owner@example.edu",
        expect.anything(),
      ),
    );
    await waitFor(() => expect(otpField()).toBeTruthy());
    expect((screen.getByLabelText(/^email/i) as HTMLInputElement).value).toBe(
      "owner@example.edu",
    );
    expect(liveRegion().textContent).toMatch(/confirm your email/i);
  });

  it("429 → 'Too many attempts…' with email offered, never 'Try again'", async () => {
    pk.signIn.mockRejectedValueOnce(refused(429, { code: "rate_limited" }));
    renderLogin();
    fireEvent.click(passkeyButton());
    await waitFor(() =>
      expect(liveRegion().textContent).toMatch(/too many attempts/i),
    );
    expect(screen.queryByRole("button", { name: /^try again$/i })).toBeNull();
  });

  it("'Email me a code instead' on step 1 mails a code to the typed address", async () => {
    pk.signIn.mockRejectedValueOnce(refused(401, { code: "passkey_failed" }));
    renderLogin();
    typeEmail("user@example.edu");
    fireEvent.click(passkeyButton());
    const instead = await screen.findByRole("button", {
      name: /email me a code instead/i,
    });
    fireEvent.click(instead);
    await waitFor(() =>
      expect(requestEmail).toHaveBeenCalledWith(
        "user@example.edu",
        expect.anything(),
      ),
    );
    await waitFor(() => expect(otpField()).toBeTruthy());
    expect(liveRegion().textContent).toBe("");
  });

  it("a bridge failure after a good passkey is the session toast, not a passkey message", async () => {
    completeSignInWith.mockRejectedValueOnce(
      Object.assign(new Error("session-bridge-failed"), { stage: "bridge" }),
    );
    renderLogin();
    fireEvent.click(passkeyButton());
    await waitFor(() => expect(showNotification).toHaveBeenCalledTimes(1));
    expect(liveRegion().textContent).toBe("");
  });

  it("autofill: a sign-in runs the shared tail as a passkey sign-in with the screens", async () => {
    renderLogin();
    await waitFor(() => expect(pk.handlers).toBeTruthy());
    const res = { id: "i", email: "a@b.test", workspaceId: "w" };
    act(() => pk.handlers!.onSignedIn(res));
    await waitFor(() => expect(completeSignInWith).toHaveBeenCalledTimes(1));
    expect(completeSignInWith.mock.calls[0][1]).toEqual({
      method: "passkey",
      screens: true,
    });
    await expect(completeSignInWith.mock.calls[0][0]()).resolves.toBe(res);
  });

  it("autofill: a 429 is announced; an older platform hides the button silently", async () => {
    renderLogin();
    await waitFor(() => expect(pk.handlers).toBeTruthy());
    act(() =>
      pk.handlers!.onFailure(
        httpFailureFn("request", 429, { code: "rate_limited" }, null),
      ),
    );
    await waitFor(() =>
      expect(liveRegion().textContent).toMatch(/too many attempts/i),
    );
    act(() => pk.handlers!.onFailure(httpFailureFn("options", 405, {}, null)));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /passkey/i })).toBeNull(),
    );
    expect(liveRegion().textContent).toBe("");
  });

  it("the email code path asks for the post-sign-in screens", async () => {
    await openCodeStep();
    pasteOtp("123456");
    await waitFor(() => expect(completeSignIn).toHaveBeenCalledTimes(1));
    expect(completeSignIn.mock.calls[0][1]).toEqual({ screens: true });
  });

  it("renders the nudge INSTEAD of the sign-in form, and leaves through continueAfterSignIn", () => {
    pk.postSignIn = { kind: "nudge" };
    renderLogin();
    expect(screen.queryByRole("heading", { name: /^sign in$/i })).toBeNull();
    expect(pk.arm).not.toHaveBeenCalled(); // no autofill behind a signed-in screen
    fireEvent.click(screen.getByRole("button", { name: "nudge-stub" }));
    expect(continueAfterSignIn).toHaveBeenCalledTimes(1);
  });

  it("renders the reminder with its days left", () => {
    pk.postSignIn = { kind: "reminder", daysLeft: 12 };
    renderLogin();
    fireEvent.click(screen.getByRole("button", { name: "reminder-stub 12" }));
    expect(continueAfterSignIn).toHaveBeenCalledTimes(1);
  });
});
