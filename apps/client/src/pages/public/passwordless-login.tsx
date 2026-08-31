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
 * Passwordless sign-in (magic link + OTP). Two states:
 *   1. enter email → request a sign-in email (response is always generic — no account disclosure);
 *   2. "check your email" → click the emailed link OR type the 6-digit code here.
 * There is no password field anywhere.
 */
export default function PasswordlessLogin() {
  const { t } = useTranslation();
  const { requestEmail, completeSignIn, isRequesting, isVerifying } = usePasswordless();
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [sent, setSent] = useState(false);

  async function onRequest(e: FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    if (await requestEmail(trimmed)) setSent(true);
  }

  async function onVerify(e: FormEvent) {
    e.preventDefault();
    if (otp.length < 6) return;
    try {
      await completeSignIn({ email: email.trim(), otp });
    } catch {
      notifications.show({
        color: "red",
        message: t("That code is invalid, expired, or already used. Request a new one."),
      });
      setOtp("");
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

          {!sent ? (
            <>
              <Text c="dimmed" ta="center" mb="lg">
                {t("Enter your email and we'll send you a sign-in link and a one-time code.")}
              </Text>
              <form onSubmit={onRequest}>
                <TextInput
                  id="email"
                  type="email"
                  label={t("Email")}
                  placeholder="email@vanderbilt.edu"
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
            </>
          ) : (
            <>
              <Text c="dimmed" ta="center" mb="lg">
                {t(
                  "Check your email. Open the sign-in link, or enter the 6-digit code below. Both expire shortly and can be used once.",
                )}
              </Text>
              <form onSubmit={onVerify}>
                <Stack align="center" gap="md">
                  <PinInput
                    length={6}
                    type="number"
                    inputMode="numeric"
                    oneTimeCode
                    value={otp}
                    onChange={setOtp}
                    aria-label={t("One-time code")}
                  />
                  <Button type="submit" fullWidth loading={isVerifying} disabled={otp.length < 6}>
                    {t("Sign in with code")}
                  </Button>
                </Stack>
              </form>
              <Group justify="center" mt="md" gap="xs">
                <Button variant="subtle" size="xs" onClick={() => requestEmail(email.trim())} loading={isRequesting}>
                  {t("Resend email")}
                </Button>
                <Button
                  variant="subtle"
                  size="xs"
                  onClick={() => {
                    setSent(false);
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
