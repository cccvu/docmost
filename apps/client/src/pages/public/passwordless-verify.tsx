import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Alert, Anchor, Button, Container, Text, Title } from "@mantine/core";
import { Helmet } from "react-helmet-async";
import { useTranslation } from "react-i18next";
import { PublicShell } from "@/features/public/components/public-shell.tsx";
import { usePasswordless } from "@/features/public/hooks/use-passwordless.ts";
import APP_ROUTE from "@/lib/app-route.ts";
import { getAppName } from "@/lib/config.ts";

/**
 * Magic-link landing page (`/login/verify#token=...`).
 *
 * SECURITY — DO NOT AUTO-SUBMIT / AUTO-LOGIN HERE. Institutional mailboxes are fronted by Microsoft
 * Defender / Proofpoint "Safe Links", which pre-fetches every emailed URL AND executes the landing
 * page's JavaScript in a sandbox before the human ever clicks. Our sister project verified this in
 * production: a scanner bot redeemed each single-use token seconds before the real user (who then
 * got a 409). The token is therefore consumed ONLY by an explicit human button click below — a
 * scanner that merely loads this page (even running its JS) never clicks the button, so the token
 * survives until the person acts. Never add a useEffect that submits on mount.
 *
 * SECURITY — THE TOKEN IS IN THE FRAGMENT, NEVER THE QUERY STRING (issue #319). A fragment is never
 * put on the wire: the browser strips it before the request leaves, so it reaches neither the front
 * door, nor the ALB (whose access log records the full request line and offers no redaction, in an
 * AWS account shared with other VUIT projects), nor the WAF, nor any `Referer` header. Because the
 * GET that loads this page consumes nothing — see the click gate above — a token in that request
 * line would stay LIVE for its whole TTL. Reading `?token=` here, even as a fallback, would put it
 * back on the wire; the query string is deliberately ignored, and a test asserts that.
 */

/** The ONE place the link token is read. Fragment only — see the docblock above. */
function readLinkToken(hash: string): string {
  return new URLSearchParams(hash.replace(/^#/, "")).get("token") ?? "";
}

export default function PasswordlessVerify() {
  const { t } = useTranslation();
  const { hash } = useLocation();
  // Held in state rather than read at redeem time, because onComplete deliberately blanks the fragment before
  // redeeming — a later read of the address bar would come back empty.
  const [token, setToken] = useState(() => readLinkToken(hash));

  // ...but a first-render-only capture is NOT enough. Opening a second sign-in link in a tab that is already
  // on this page changes only the fragment, which is a SAME-DOCUMENT navigation: this component never
  // remounts, so it would keep redeeming the FIRST link's token and the user would get "invalid, expired, or
  // already used" on a link that is none of those. Caught in a real browser, not by a unit test.
  //
  // This effect only READS the fragment. It must never call completeSignIn — see the Safe-Links docblock
  // above; a scanner runs this page's JS, and an effect that submits is exactly the token burn we prevent.
  // It also never CLEARS the token: onComplete blanks the fragment on purpose, and losing the token between
  // that write and the request would break the very sign-in it is redeeming.
  useEffect(() => {
    const next = readLinkToken(hash);
    if (next && next !== token) setToken(next);
  }, [hash, token]);
  const { completeSignIn, isVerifying } = usePasswordless();
  const [error, setError] = useState<string | null>(null);

  /**
   * Drop the live token from the address bar and from this history entry at the moment the user commits
   * to redeeming it. NOT on mount: a reload before the click must still work, and until the click this
   * URL is the only copy the user holds. (History is synced across devices by some browsers, so a
   * consumed token left in the bar outlives the tab.)
   *
   * Returns the fragment it removed so a FAILED redeem can put it back — see onComplete. Never throws:
   * `replaceState` can reject in sandboxed/opaque-origin contexts, and this is a cosmetic cleanup, so a
   * failure here must not be allowed to prevent the sign-in it precedes.
   */
  function stripFragment(): string {
    if (
      typeof window === "undefined" ||
      typeof window.history?.replaceState !== "function"
    ) {
      return "";
    }
    const previous = window.location.hash;
    try {
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );
    } catch {
      return "";
    }
    return previous;
  }

  async function onComplete() {
    setError(null);
    const removed = stripFragment();
    try {
      await completeSignIn({ token });
    } catch (err) {
      // The redeem did not succeed, so the token may well still be LIVE (a 5xx or a dropped connection
      // consumes nothing). We just deleted the user's only copy of it, so put it back: before this PR a
      // reload after a failed attempt still worked, and silently breaking that would turn a transient
      // network blip into "this sign-in link is invalid". Restoring a token that IS dead is harmless.
      if (removed) {
        try {
          window.history.replaceState(null, "", removed);
        } catch {
          /* cosmetic only — `token` is still in React state, so the retry button works regardless */
        }
      }
      // The link was valid but the session bridge failed → say so, don't cry "invalid link".
      const bridge = (err as { stage?: string })?.stage === "bridge";
      setError(
        bridge
          ? t(
              "You're verified, but we couldn't open your workspace session. Please try again.",
            )
          : t(
              "This sign-in link is invalid, expired, or already used. Please request a new one.",
            ),
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
              {/*
                This names the EXACT affordance on the sign-in page ("I already have a code"), because
                the obvious path there — type your email, press the button — issues a fresh token and
                supersedes the very code this notice is sending the user to type (#319 review).
              */}
              {t(
                "This sign-in link is missing its token. The same email also contains a 6-digit code that still works: open the ",
              )}
              <Anchor component={Link} to={APP_ROUTE.AUTH.LOGIN}>
                {t("sign-in page")}
              </Anchor>
              {t(
                ', enter your email address, and choose "I already have a code".',
              )}
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
