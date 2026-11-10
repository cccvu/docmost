import { ChangeEvent, FormEvent, useRef, useState } from "react";
import {
  Anchor,
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
 */
export default function PasswordlessLogin() {
  const { t } = useTranslation();
  const { requestEmail, completeSignIn, isRequesting, isVerifying } =
    usePasswordless();
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
  const cooldown = useResendCooldown(RESEND_COOLDOWN_SECONDS);

  async function onRequest(e: FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    if (await requestEmail(trimmed)) {
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
      await completeSignIn({ email: email.trim(), otp: normalizeOtp(code) });
    } catch (err) {
      // Distinguish "the code was fine but the session bridge failed" from "bad code" (see use-passwordless).
      if ((err as { stage?: string })?.stage === "bridge") {
        notifications.show({
          color: "red",
          message: t(
            "You're verified, but we couldn't open your workspace session. Please try again.",
          ),
        });
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
      otpRef.current?.focus();
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
          <Title order={1} size="h2" ta="center" fw={600} mb="xs">
            {t("Sign in")}
          </Title>

          {!sent && !haveCode ? (
            <>
              <Text c="dimmed" ta="center" mb="lg">
                {t("Enter your email and we'll send you a sign-in link.")}
              </Text>
              <form onSubmit={onRequest}>
                <TextInput
                  id="email"
                  type="email"
                  label={t("Email")}
                  placeholder="email@example.edu"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.currentTarget.value)}
                />
                <Button type="submit" fullWidth mt="lg" loading={isRequesting}>
                  {t("Email me a sign-in link")}
                </Button>
              </form>
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
                  swallows the click in silence. The user's next move is then "Email me a sign-in link",
                  which supersedes the very code they came to redeem: the #319 failure arriving through
                  a different door. The address is collected on the next step instead, where it is visible and
                  correctable.
                */}
                <Anchor
                  component="button"
                  type="button"
                  onClick={() => setHaveCode(true)}
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
                      "Check your email and open the sign-in link. If the email also has a code, you can enter it below instead. It expires shortly and can be used once.",
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
                    loading={isVerifying}
                    disabled={!hasMinimumDigits(otp) || !email.trim()}
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
                  onClick={async () => {
                    // Await the result before claiming anything. `requestEmail` resolves false rather than
                    // throwing, so an optimistic `setSent(true)` would permanently flip the copy to "Check
                    // your email" for a message that never went — and would clear the code the user is
                    // holding on the way. Mirrors onRequest, which already gets this right.
                    if (await requestEmail(email.trim())) {
                      setOtp("");
                      setOtpError(null);
                      autoSubmitted.current = null;
                      setSent(true);
                      cooldown.start();
                    }
                  }}
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
            </>
          )}
        </Container>
      </PublicShell>
    </>
  );
}
