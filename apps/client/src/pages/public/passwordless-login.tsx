import { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";
import {
  Anchor,
  Box,
  Button,
  Container,
  Group,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { notifications } from "@mantine/notifications";
import { PublicShell } from "@/features/public/components/public-shell.tsx";
import { usePasswordless } from "@/features/public/hooks/use-passwordless.ts";
import { useResendCooldown } from "@/features/public/hooks/use-resend-cooldown.ts";
import {
  OTP_INPUT_MAX_LENGTH,
  RESEND_COOLDOWN_SECONDS,
  hasMinimumDigits,
  isBulkEntry,
  isCompleteOtp,
  isRateLimited,
  normalizeOtp,
  tooManyRequestsMessage,
} from "@/features/public/otp-code.ts";
import APP_ROUTE from "@/lib/app-route.ts";
import { getAppName } from "@/lib/config.ts";
import { PasskeyNudge } from "@/features/passkeys/components/passkey-nudge.tsx";
import { PasskeyReminder } from "@/features/passkeys/components/passkey-reminder.tsx";
import { armPasskeyAutofill } from "@/features/passkeys/lib/autofill.ts";
import { passkeysSupported } from "@/features/passkeys/lib/capabilities.ts";
import {
  PasskeyError,
  passkeyUiAction,
  toPasskeyFailure,
  type PasskeyOperation,
} from "@/features/passkeys/lib/passkey-errors.ts";
import { signInWithPasskey } from "@/features/passkeys/services/passkey-api.ts";
import type { PasskeySignInResponse } from "@/features/passkeys/types.ts";

/** A passkey outcome the page announces (#818): the text, plus which follow-ups to offer under it. */
interface PasskeyNotice {
  message: string;
  /** Offer "Email me a code instead". */
  offerEmail: boolean;
  /** Offer "Try again" (a new click, so a new ceremony). */
  retry: boolean;
}

/**
 * Passwordless sign-in (magic link + OTP). Two steps, reachable two ways:
 *   1. enter email → request a sign-in email (response is always generic — no account disclosure);
 *   2. the code step → click the emailed link OR enter the emailed code here.
 *
 * Step 2 is ALSO reachable WITHOUT requesting anything, via "I already have a code" (#319 review).
 * That path is load-bearing, not a convenience: issuing supersedes every prior live token for the
 * address (`issuePasswordlessToken` → `invalidateOutstanding`), so if the only way to reach this
 * field were `requestEmail`, then a user holding a perfectly good code — the one the magic-link
 * page tells them to fall back to, and the one `admin:login-link` break-glass prints — would have
 * to destroy it in order to type it. The OTP is the documented recovery path for a link whose
 * fragment a mail rewriter dropped (ADR 0018); a recovery path that invalidates the credential it
 * recovers is not one. Reaching this step is a pure client-side state change: it discloses nothing
 * and costs nothing, because the code itself is still verified server-side.
 *
 * The code field (#815) is ONE text field, not a row of cells: the code is moving from 6 to 8 digits, eight cells
 * overflow a 360 px phone, and a row of cells cannot take a pasted "1234 5678". It takes 6 to 12 digits with spaces
 * and hyphens ignored (`otp-code.ts`), so either length works across the rollout. A paste or an autofill of a whole
 * code submits it once; typing never does, so a person who types always presses the button themselves.
 *
 * Passkeys (#818) sit beside the email path, never in front of it:
 *   - step 1's email field is `autoComplete="username webauthn"`, and a conditional (autofill) request is armed while
 *     step 1 shows (`armPasskeyAutofill`); it is aborted on a step change, on unmount and before a button starts its
 *     own ceremony, and it re-arms itself only on `passkey_challenge_expired`;
 *   - "Sign in with a passkey" (step 1) and "Didn't get a code? Sign in with a passkey" (the code step) each run ONE
 *     ceremony straight from the click (Safari's user-gesture rule: `completeSignInWith` calls the verifier before
 *     its first await, and the verifier's first await is its one native options fetch);
 *   - every passkey outcome is announced in ONE polite live region, with "Try again" / "Email me a code instead"
 *     under it as the error table says; `email_confirmation_required` (the 90-day rule) moves to the code step for
 *     the address the platform names and mails a code;
 *   - an older platform without the routes (404/405), or a browser without WebAuthn, hides every passkey control;
 *   - after the wiki session opens, the shared tail may show the nudge (email sign-in) or the reminder (passkey
 *     sign-in) before navigating (`usePasswordless`; never on an OAuth resume).
 */
export default function PasswordlessLogin() {
  const { t } = useTranslation();
  const {
    requestEmail,
    completeSignIn,
    completeSignInWith,
    continueAfterSignIn,
    postSignIn,
    isRequesting,
    isVerifying,
  } = usePasswordless();
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [sent, setSent] = useState(false);
  // Arrived at the code step holding a code we did NOT just issue (see the docblock). Kept separate
  // from `sent` so the copy can stay truthful: "check your email" is a lie if we sent nothing.
  const [haveCode, setHaveCode] = useState(false);
  // A code-format or verify error, shown on the field itself (role="alert", so it is announced).
  const [otpError, setOtpError] = useState<string | null>(null);
  // The last code a paste or autofill submitted on its own: each such entry submits once, never in a loop.
  const autoSubmitted = useRef<string | null>(null);
  const otpRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const cooldown = useResendCooldown(RESEND_COOLDOWN_SECONDS);

  // #818 passkeys. Hidden for good on this page load once the browser lacks WebAuthn or the platform lacks the routes.
  const [passkeysOff, setPasskeysOff] = useState(() => !passkeysSupported());
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyNotice, setPasskeyNotice] = useState<PasskeyNotice | null>(
    null,
  );
  // The armed autofill request's disarm, so a button can cancel it BEFORE its own ceremony starts.
  const disarmAutofill = useRef<(() => void) | null>(null);
  const onFirstStep = !sent && !haveCode && !postSignIn;

  function showBridgeFailure() {
    notifications.show({
      color: "red",
      message: t(
        "You're verified, but we couldn't open your workspace session. Please try again.",
      ),
    });
  }

  // A button's passkey sign-in. Runs synchronously up to the verifier's one native fetch: nothing here awaits before
  // `completeSignInWith` calls `signInWithPasskey` (Safari's user-gesture rule).
  function onPasskeySignIn() {
    if (passkeyBusy || isVerifying) return;
    // Cancel the autofill request first: one ceremony at a time, and it must not outlive this click.
    disarmAutofill.current?.();
    disarmAutofill.current = null;
    setPasskeyNotice(null);
    setPasskeyBusy(true);
    void completeSignInWith(() => signInWithPasskey(), {
      method: "passkey",
      screens: true,
    })
      .catch((error) => onPasskeyFailure("signin", error))
      .finally(() => setPasskeyBusy(false));
  }

  // The #818 error table (`passkeyUiAction`) applied to the login page.
  async function onPasskeyFailure(op: PasskeyOperation, error: unknown) {
    // The passkey WAS good but the wiki session did not open (the tail rolled the platform session back).
    if ((error as { stage?: string } | null)?.stage === "bridge") {
      showBridgeFailure();
      return;
    }
    const action = passkeyUiAction(op, toPasskeyFailure(error), t);
    switch (action.kind) {
      case "none":
      case "rearm":
        return;
      case "hide":
        setPasskeysOff(true);
        // The person who clicked deserves a word; an autofill nobody touched does not.
        setPasskeyNotice(
          op === "signin"
            ? {
                message: t(
                  "Passkey sign-in isn't available right now. Use an emailed code instead.",
                ),
                offerEmail: false,
                retry: false,
              }
            : null,
        );
        return;
      case "code-step":
        await toCodeStepForConfirmation(action.email);
        return;
      case "message":
        setPasskeyNotice({
          message: action.message,
          offerEmail: action.offerEmail,
          retry: action.retry,
        });
        return;
      default:
        setPasskeyNotice({
          message: t("We couldn't sign you in with that passkey."),
          offerEmail: true,
          retry: true,
        });
    }
  }

  // `403 email_confirmation_required` on a passkey sign-in: the passkey is past the 90-day rule. Move to the code step
  // for the address the platform named (only the passkey's holder gets that answer) and mail a code. On the code step
  // inside the resend countdown, a code is already on its way: point at it instead of superseding it.
  async function toCodeStepForConfirmation(address: string | null) {
    const target = (address ?? email).trim();
    if (address) setEmail(address);
    if (!target) {
      setPasskeyNotice({
        message: t("Confirm with a code from your email this time."),
        offerEmail: false,
        retry: false,
      });
      emailRef.current?.focus();
      return;
    }
    if (!onFirstStep && cooldown.remaining > 0) {
      setPasskeyNotice({
        message: t(
          "To keep using your passkey, confirm your email: enter the code we sent you.",
        ),
        offerEmail: false,
        retry: false,
      });
      otpRef.current?.focus();
      return;
    }
    if (await sendCode(target)) {
      setPasskeyNotice({
        message: t(
          "To keep using your passkey, confirm your email: we sent you a sign-in code.",
        ),
        offerEmail: false,
        retry: false,
      });
    }
  }

  // Mail a sign-in code and show the code step. Resolves false (the hook has already said why) when it was not sent.
  async function sendCode(address: string): Promise<boolean> {
    if (!(await requestEmail(address, { onRetryAfter: cooldown.start }))) {
      return false;
    }
    setOtp("");
    setOtpError(null);
    autoSubmitted.current = null;
    setSent(true);
    cooldown.start();
    return true;
  }

  // "Email me a code instead", under a passkey notice.
  function onEmailInstead() {
    setPasskeyNotice(null);
    const address = email.trim();
    if (onFirstStep) {
      if (address) void sendCode(address);
      else emailRef.current?.focus();
      return;
    }
    // The code step: a fresh code unless one was just sent (each send supersedes the one on its way).
    if (address && cooldown.remaining === 0) void sendCode(address);
    else otpRef.current?.focus();
  }

  // The autofill callbacks fire long after arming; they read this render's handlers through a ref, never a stale
  // closure (the address, the step).
  const autofillHandlers = useRef({
    onSignedIn: (_res: PasskeySignInResponse) => {},
    onFailure: (_error: unknown) => {},
  });
  useEffect(() => {
    autofillHandlers.current = {
      onSignedIn: (res) => {
        void completeSignInWith(async () => res, {
          method: "passkey",
          screens: true,
        }).catch((error) => onPasskeyFailure("autofill", error));
      },
      onFailure: (error) => void onPasskeyFailure("autofill", error),
    };
  });

  // Arm the conditional request while step 1 shows; the cleanup aborts it on a step change and on unmount.
  useEffect(() => {
    if (!onFirstStep || passkeysOff) return;
    const disarm = armPasskeyAutofill({
      onSignedIn: (res) => autofillHandlers.current.onSignedIn(res),
      onFailure: (failure) =>
        autofillHandlers.current.onFailure(new PasskeyError(failure)),
    });
    disarmAutofill.current = disarm;
    return () => {
      disarm();
      if (disarmAutofill.current === disarm) disarmAutofill.current = null;
    };
  }, [onFirstStep, passkeysOff]);

  async function onRequest(e: FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    setPasskeyNotice(null);
    if (await requestEmail(trimmed, { onRetryAfter: cooldown.start })) {
      setSent(true);
      cooldown.start();
    }
  }

  async function verifyCode(code: string) {
    // The address can legitimately be blank here: "I already have a code" reaches this step without one.
    if (!email.trim()) return;
    if (!isCompleteOtp(code)) {
      setOtpError(t("Enter the code from your email. It is 6 to 12 digits."));
      otpRef.current?.focus();
      return;
    }
    setOtpError(null);
    try {
      // `screens`: this page renders the #818 nudge/reminder the shared tail may ask for.
      await completeSignIn(
        { email: email.trim(), otp: normalizeOtp(code) },
        { screens: true },
      );
    } catch (err) {
      // Distinguish "the code was fine but the session bridge failed" from "bad code" (see use-passwordless).
      if ((err as { stage?: string })?.stage === "bridge") {
        showBridgeFailure();
        return;
      }
      if (isRateLimited(err)) {
        // A throttle says so and keeps the code: it may still be good once the wait is over.
        setOtpError(tooManyRequestsMessage(err, t));
      } else {
        setOtpError(
          t(
            "That code is invalid, expired, or already used. Request a new one.",
          ),
        );
        setOtp("");
      }
      // Select what is left (the kept code after a 429): a paste of a fresh code then replaces it rather than
      // appending to it, which would make a 12-digit value that auto-submits and can never be right.
      otpRef.current?.focus();
      otpRef.current?.select();
    }
  }

  function onVerify(e: FormEvent) {
    e.preventDefault();
    void verifyCode(otp);
  }

  function onOtpChange(e: ChangeEvent<HTMLInputElement>) {
    const next = e.currentTarget.value;
    const inputType = (e.nativeEvent as Partial<InputEvent> | undefined)
      ?.inputType;
    const bulk = isBulkEntry(otp, next, inputType);
    setOtp(next);
    setOtpError(null);
    // A pasted or autofilled whole code submits itself, once. Typing never does.
    const code = normalizeOtp(next);
    if (
      bulk &&
      isCompleteOtp(next) &&
      email.trim() &&
      !isVerifying &&
      autoSubmitted.current !== code
    ) {
      autoSubmitted.current = code;
      void verifyCode(next);
    }
  }

  return (
    <>
      <Helmet>
        <title>
          {t("Sign in")} — {getAppName()}
        </title>
      </Helmet>

      <PublicShell>
        <Container size={460} py={{ base: 32, sm: 64 }}>
          {postSignIn ? (
            // #818: signed in, wiki session open; one screen before the page the person was going to.
            postSignIn.kind === "nudge" ? (
              <PasskeyNudge onDone={continueAfterSignIn} />
            ) : (
              <PasskeyReminder
                daysLeft={postSignIn.daysLeft}
                onDone={continueAfterSignIn}
              />
            )
          ) : (
            <>
              <Title order={1} size="h2" ta="center" fw={600} mb="xs">
                {t("Sign in")}
              </Title>

              {!sent && !haveCode ? (
                <>
                  <Text c="dimmed" ta="center" mb="lg">
                    {t("Enter your email and we'll send you a sign-in code.")}
                  </Text>
                  <form onSubmit={onRequest}>
                    {/*
                      `username webauthn` (#818): the address is the account name, and `webauthn` lets the browser
                      offer this site's passkeys in the field's suggestions while the autofill request is armed.
                    */}
                    <TextInput
                      ref={emailRef}
                      id="email"
                      type="email"
                      label={t("Email")}
                      placeholder="email@example.edu"
                      autoComplete="username webauthn"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.currentTarget.value)}
                    />
                    <Button
                      type="submit"
                      fullWidth
                      mt="lg"
                      loading={isRequesting}
                    >
                      {t("Email me a sign-in code")}
                    </Button>
                  </form>
                  {!passkeysOff && (
                    <Button
                      variant="default"
                      fullWidth
                      mt="sm"
                      onClick={onPasskeySignIn}
                      loading={passkeyBusy}
                    >
                      {t("Sign in with a passkey")}
                    </Button>
                  )}
                  <Text ta="center" mt="md" size="sm" c="dimmed">
                    {t("No account yet?")}{" "}
                    <Anchor component={Link} to={APP_ROUTE.AUTH.REQUEST_ACCESS}>
                      {t("Request access")}
                    </Anchor>
                  </Text>
                  {/*
                Reaching the code step WITHOUT issuing a new token — see the docblock. Requesting
                would supersede the code the user is holding, so this must not call requestEmail.
                Needs the address because completeSignIn verifies { email, otp } as a pair.
              */}
                  <Text ta="center" mt="xs" size="sm" c="dimmed">
                    {/*
                  NEVER `disabled`. Mantine's Anchor ships no `:disabled` rule — its only styling is the link
                  colour, a pointer cursor and a hover underline — so a disabled one looks completely live and
                  swallows the click in silence. The user's next move is then "Email me a sign-in code",
                  which supersedes the very code they came to redeem: the #319 failure arriving through
                  a different door. The address is collected on the next step instead, where it is visible and
                  correctable.
                */}
                    <Anchor
                      component="button"
                      type="button"
                      onClick={() => {
                        setPasskeyNotice(null);
                        setHaveCode(true);
                      }}
                    >
                      {t("I already have a code")}
                    </Anchor>
                  </Text>
                </>
              ) : (
                <>
                  {/* role="status" announces the step change to screen readers when we swap email→code. */}
                  <Text
                    c="dimmed"
                    ta="center"
                    mb={sent ? "xs" : "lg"}
                    role="status"
                  >
                    {sent
                      ? t(
                          "Check your email and enter the code below. If the email has a sign-in link, opening it works too. The code expires shortly and can be used once.",
                        )
                      : t(
                          "Enter the code from your sign-in email. It expires shortly and can be used once.",
                        )}
                  </Text>
                  {sent && (
                    <Text c="dimmed" ta="center" size="sm" mb="lg">
                      {t("Can't find it? Check your Junk or Clutter folder.")}
                    </Text>
                  )}
                  <form onSubmit={onVerify}>
                    <Stack align="center" gap="md">
                      {/*
                    The address is shown and editable HERE, not hidden behind the previous step. The code is
                    verified as an { email, otp } PAIR, so a typo comes back as "That code is invalid, expired,
                    or already used" — blaming the code and sending the user to request a new one, which
                    destroys the good code they were holding. Showing the pair makes the real mistake fixable.
                  */}
                      <TextInput
                        id="verify-email"
                        type="email"
                        label={t("Email")}
                        placeholder="email@example.edu"
                        autoComplete="email"
                        required
                        w="100%"
                        // Focus follows the field that is actually empty. Arriving via "I already have a
                        // code" there is no address yet, so focusing the code field would skip straight past
                        // it — and because Mantine puts `disabled` on the submit button as the NATIVE
                        // attribute, that button leaves the tab order while either field is incomplete. The
                        // next Tab from the code field would then land on "Resend email", whose Enter
                        // supersedes the code just typed. Focusing here keeps the order honest.
                        autoFocus={!sent}
                        value={email}
                        onChange={(e) => setEmail(e.currentTarget.value)}
                      />
                      {/*
                    One text field (#815): 6 to 12 digits, spaces and hyphens ignored, so "1234 5678" pastes
                    whole. Plain text, never type="number", which drops a leading zero and refuses the space.
                    WCAG 2.2 SC 3.3.8: paste and the OS one-time-code autofill both work, and nothing has to be
                    retyped. The error is the field's own, with role="alert" so it is announced.
                  */}
                      <TextInput
                        ref={otpRef}
                        id="verify-otp"
                        label={t("One-time code")}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck={false}
                        maxLength={OTP_INPUT_MAX_LENGTH}
                        w="100%"
                        // Only when we just sent the email: then the address is already known and the code
                        // is the empty field. See the note on the TextInput above.
                        autoFocus={sent}
                        value={otp}
                        onChange={onOtpChange}
                        error={otpError}
                        errorProps={{ role: "alert" }}
                      />
                      <Button
                        type="submit"
                        fullWidth
                        loading={isVerifying && !passkeyBusy}
                        disabled={
                          !hasMinimumDigits(otp) || !email.trim() || passkeyBusy
                        }
                      >
                        {t("Sign in with code")}
                      </Button>
                    </Stack>
                  </form>
                  <Group justify="center" mt="md" gap="xs">
                    {/* Resending issues a NEW token, which supersedes the code shown above — only the
                    newest code ever works. That is why it is a deliberate button and not the only
                    way to reach this step. */}
                    <Button
                      variant="subtle"
                      size="xs"
                      // Await the result before claiming anything (sendCode): `requestEmail` resolves false rather than
                      // throwing, so an optimistic `setSent(true)` would permanently flip the copy to "Check your email"
                      // for a message that never went — and would clear the code the user is holding on the way.
                      onClick={() => void sendCode(email.trim())}
                      loading={isRequesting}
                      // Reachable with a blank address since the entry guard moved to this step. Firing
                      // requestEmail("") surfaces the catch-all "we couldn't send" toast, which blames a
                      // transient outage for an empty field sitting visibly above it. Also held for 60 s
                      // after a send (#815): each resend supersedes the code that may still be on its way.
                      disabled={!email.trim() || cooldown.remaining > 0}
                    >
                      {cooldown.remaining > 0
                        ? t("Resend email ({{seconds}}s)", {
                            seconds: cooldown.remaining,
                          })
                        : t("Resend email")}
                    </Button>
                    <Button
                      variant="subtle"
                      size="xs"
                      onClick={() => {
                        setPasskeyNotice(null);
                        setSent(false);
                        setHaveCode(false);
                        setOtp("");
                        setOtpError(null);
                        autoSubmitted.current = null;
                        cooldown.reset();
                      }}
                    >
                      {t("Use a different email")}
                    </Button>
                  </Group>
                  {!passkeysOff && (
                    <Group justify="center" mt="xs">
                      <Button
                        variant="subtle"
                        size="xs"
                        onClick={onPasskeySignIn}
                        loading={passkeyBusy}
                      >
                        {t("Didn't get a code? Sign in with a passkey")}
                      </Button>
                    </Group>
                  )}
                </>
              )}

              {/*
            #818: ONE polite live region for every passkey outcome, on both steps. It is always mounted (a region
            that appears together with its text is often not announced); the follow-ups sit outside it so only the
            sentence is read.
          */}
              <Box role="status" aria-live="polite" mt="md" ta="center">
                {passkeyNotice ? (
                  <Text size="sm">{passkeyNotice.message}</Text>
                ) : null}
              </Box>
              {passkeyNotice &&
              (passkeyNotice.retry || passkeyNotice.offerEmail) ? (
                <Group justify="center" mt="xs" gap="xs">
                  {passkeyNotice.retry && !passkeysOff ? (
                    <Button variant="light" size="xs" onClick={onPasskeySignIn}>
                      {t("Try again")}
                    </Button>
                  ) : null}
                  {passkeyNotice.offerEmail ? (
                    <Button variant="subtle" size="xs" onClick={onEmailInstead}>
                      {t("Email me a code instead")}
                    </Button>
                  ) : null}
                </Group>
              ) : null}
            </>
          )}
        </Container>
      </PublicShell>
    </>
  );
}
