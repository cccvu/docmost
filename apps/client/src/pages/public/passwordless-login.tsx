import { FormEvent, useState } from "react";
import {
  Anchor,
  Button,
  Container,
  Group,
  PinInput,
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
import APP_ROUTE from "@/lib/app-route.ts";
import { getAppName } from "@/lib/config.ts";

/**
 * Passwordless sign-in (magic link + OTP). Two steps, reachable two ways:
 *   1. enter email → request a sign-in email (response is always generic — no account disclosure);
 *   2. the code step → click the emailed link OR type the 6-digit code here.
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

  async function onRequest(e: FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    if (await requestEmail(trimmed)) setSent(true);
  }

  async function onVerify(e: FormEvent) {
    e.preventDefault();
    // The address can legitimately be blank here: "I already have a code" reaches this step without one.
    if (!email.trim() || otp.length < 6) return;
    try {
      await completeSignIn({ email: email.trim(), otp });
    } catch (err) {
      // Distinguish "the code was fine but the session bridge failed" from "bad code" (see use-passwordless).
      const bridge = (err as { stage?: string })?.stage === "bridge";
      notifications.show({
        color: "red",
        message: bridge
          ? t(
              "You're verified, but we couldn't open your workspace session. Please try again.",
            )
          : t(
              "That code is invalid, expired, or already used. Request a new one.",
            ),
      });
      if (!bridge) setOtp("");
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
                {t(
                  "Enter your email and we'll send you a sign-in link and a one-time code.",
                )}
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
                  {t("Email me a sign-in link and code")}
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
                  swallows the click in silence. The user's next move is then "Email me a sign-in link and
                  code", which supersedes the very code they came to redeem: the #319 failure arriving through
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
              <Text c="dimmed" ta="center" mb="lg" role="status">
                {sent
                  ? t(
                      "Check your email. Open the sign-in link, or enter the 6-digit code below. Both expire shortly and can be used once.",
                    )
                  : t(
                      "Enter the 6-digit code from your sign-in email. It expires shortly and can be used once.",
                    )}
              </Text>
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
                    // code" there is no address yet, so focusing the PinInput would skip straight past
                    // it — and because Mantine puts `disabled` on the submit button as the NATIVE
                    // attribute, that button leaves the tab order while either field is incomplete. The
                    // next Tab from the last code cell would then land on "Resend email", whose Enter
                    // supersedes the code just typed. Focusing here keeps the order honest.
                    autoFocus={!sent}
                    value={email}
                    onChange={(e) => setEmail(e.currentTarget.value)}
                  />
                  <PinInput
                    length={6}
                    type="number"
                    inputMode="numeric"
                    oneTimeCode
                    // Only when we just sent the email: then the address is already known and the code
                    // is the empty field. See the note on the TextInput above.
                    autoFocus={sent}
                    value={otp}
                    onChange={setOtp}
                    aria-label={t("One-time code")}
                  />
                  <Button
                    type="submit"
                    fullWidth
                    loading={isVerifying}
                    disabled={otp.length < 6 || !email.trim()}
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
                      setSent(true);
                    }
                  }}
                  loading={isRequesting}
                  // Reachable with a blank address since the entry guard moved to this step. Firing
                  // requestEmail("") surfaces the catch-all "we couldn't send" toast, which blames a
                  // transient outage for an empty field sitting visibly above it.
                  disabled={!email.trim()}
                >
                  {t("Resend email")}
                </Button>
                <Button
                  variant="subtle"
                  size="xs"
                  onClick={() => {
                    setSent(false);
                    setHaveCode(false);
                    setOtp("");
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
