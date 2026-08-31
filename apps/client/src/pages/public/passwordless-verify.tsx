import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Alert, Anchor, Button, Container, Text, Title } from "@mantine/core";
import { Helmet } from "react-helmet-async";
import { useTranslation } from "react-i18next";
import { PublicShell } from "@/features/public/components/public-shell.tsx";
import { usePasswordless } from "@/features/public/hooks/use-passwordless.ts";
import APP_ROUTE from "@/lib/app-route.ts";
import { getAppName } from "@/lib/config.ts";

/**
 * Magic-link landing page (`/login/verify?token=...`).
 *
 * SECURITY — DO NOT AUTO-SUBMIT / AUTO-LOGIN HERE. Vanderbilt mailboxes are fronted by Microsoft
 * Defender / Proofpoint "Safe Links", which pre-fetches every emailed URL AND executes the landing
 * page's JavaScript in a sandbox before the human ever clicks. Our sister project verified this in
 * production: a scanner bot redeemed each single-use token seconds before the real user (who then
 * got a 409). The token is therefore consumed ONLY by an explicit human button click below — a
 * scanner that merely loads this page (even running its JS) never clicks the button, so the token
 * survives until the person acts. Never add a useEffect that submits on mount.
 */
export default function PasswordlessVerify() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const { completeSignIn, isVerifying } = usePasswordless();
  const [error, setError] = useState<string | null>(null);

  async function onComplete() {
    setError(null);
    try {
      await completeSignIn({ token });
    } catch {
      setError(
        t("This sign-in link is invalid, expired, or already used. Please request a new one."),
      );
    }
  }

  return (
    <>
      <Helmet>
        <title>
          {t("Complete sign-in")} — {getAppName()}
        </title>
      </Helmet>

      <PublicShell>
        <Container size={460} py={{ base: 32, sm: 64 }}>
          <Title order={1} size="h2" ta="center" fw={600} mb="xs">
            {t("Complete sign-in")}
          </Title>

          {!token ? (
            <Alert color="yellow" title={t("Link incomplete")} role="alert">
              {t("This sign-in link is missing its token. Open the most recent link from your email, or ")}
              <Anchor component={Link} to={APP_ROUTE.AUTH.LOGIN}>
                {t("request a new one")}
              </Anchor>
              .
            </Alert>
          ) : (
            <>
              <Text c="dimmed" ta="center" mb="lg">
                {t("For your security, click below to finish signing in.")}
              </Text>
              {error && (
                <Alert color="red" mb="md" role="alert">
                  {error}{" "}
                  <Anchor component={Link} to={APP_ROUTE.AUTH.LOGIN}>
                    {t("Back to sign in")}
                  </Anchor>
                </Alert>
              )}
              <Button fullWidth loading={isVerifying} onClick={onComplete}>
                {t("Complete sign-in")}
              </Button>
            </>
          )}
        </Container>
      </PublicShell>
    </>
  );
}
