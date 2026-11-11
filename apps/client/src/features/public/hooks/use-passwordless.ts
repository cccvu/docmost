import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import {
  logout,
  openDocmostSession,
} from "@/features/auth/services/auth-service";
import {
  requestPasswordless,
  verifyPasswordless,
} from "@/features/public/services/public-service.ts";
import APP_ROUTE, { getPostLoginRedirect } from "@/lib/app-route.ts";
import { isRateLimited, tooManyRequestsMessage } from "@/features/public/otp-code.ts";
import { retryAfterMs } from "@/features/request-errors/request-error.ts";

/**
 * Passwordless sign-in orchestration (magic link + OTP). Reuses the SAME two-step the password login
 * used (see use-auth.ts): a verified passwordless sign-in only sets the PLATFORM session, so we must
 * openDocmostSession() (the BFF bridge) BEFORE navigating, and roll the platform session back if that
 * bridge fails — otherwise the app mounts with a live platform cookie but 401ing Docmost /api/* calls.
 */
export function usePasswordless() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [isRequesting, setIsRequesting] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);

  // Returns true once the request is accepted (the response is always generic — no account disclosure).
  // `onRetryAfter` hears a 429's Retry-After in seconds, so the page can hold "Resend email" that long (#815).
  async function requestEmail(
    email: string,
    opts?: { onRetryAfter?: (seconds: number) => void },
  ): Promise<boolean> {
    setIsRequesting(true);
    try {
      await requestPasswordless({ email });
      return true;
    } catch (err) {
      // #815: a throttle is not an outage. Say so, and say how long (Retry-After when the response carries one);
      // "try again in a moment" would send the person straight back into the same limit.
      const waitMs = isRateLimited(err) ? retryAfterMs(err) : null;
      if (waitMs !== null) opts?.onRetryAfter?.(Math.ceil(waitMs / 1000));
      notifications.show({
        color: "red",
        message: isRateLimited(err)
          ? tooManyRequestsMessage(err, t)
          : t("We couldn't send a sign-in email right now. Please try again in a moment."),
      });
      return false;
    } finally {
      setIsRequesting(false);
    }
  }

  // Complete sign-in from either channel. Throws are surfaced to the caller (which shows the message)
  // so the interstitial page can render an inline error without a redirect loop. The two failure modes
  // are DISTINGUISHED: a `verifyPasswordless` throw means the code/link is invalid/expired/used, while a
  // bridge failure (the code WAS valid) is re-thrown tagged `stage: "bridge"` so the page shows a
  // "verified but couldn't open your session" message instead of a misleading "invalid code".
  async function completeSignIn(
    args: { token: string } | { email: string; otp: string },
  ): Promise<void> {
    setIsVerifying(true);
    // On the resume branch we hand off to a FULL-PAGE navigation, which does not tear the page down
    // synchronously — so clearing `isVerifying` in `finally` would re-enable the sign-in button mid-navigation
    // and invite a double-submit that re-verifies an already-consumed OTP/token (a confusing "invalid code"
    // flash). Keep the spinner up through the redirect, matching use-auth.ts (#302 review, Frontend).
    let redirecting = false;
    try {
      const res = await verifyPasswordless(args); // throws => invalid / expired / already-used code or link

      // OAuth resume (#302): this browser began an MCP OAuth flow before signing in. The pending
      // /oauth/authorize request is parked server-side; we must return to it with a FULL-PAGE navigation
      // (it is a platform route, not an SPA route — React-Router navigate() would 404). Establish the Docmost
      // session best-effort so any later same-browser wiki use works, but a bridge failure here is NON-FATAL:
      // OAuth consent needs only the platform session, and rolling back (logout) would wipe the very session
      // the resume depends on. So on resume we never call logout() on a bridge failure.
      if (res?.resume) {
        try {
          await openDocmostSession();
        } catch {
          // non-fatal on the resume path — the platform session alone satisfies /oauth/authorize + consent.
        }
        redirecting = true;
        window.location.assign("/oauth/authorize");
        return;
      }

      // Normal path: the app is about to mount the wiki SPA, so a missing Docmost session must fail closed —
      // establish it before navigating, and roll back the platform session on failure so a half-authenticated
      // state (live platform cookie but 401ing Docmost /api/*) never persists.
      try {
        await openDocmostSession();
      } catch {
        await logout().catch(() => undefined);
        throw Object.assign(new Error("session-bridge-failed"), { stage: "bridge" as const });
      }
      // #797: a first self-service sign-in. The platform reports it once (the account it creates or activates is
      // never "provisioned" again), so this notice is one-time by construction. It stays until dismissed: the
      // navigation below swaps the page underneath it. Neutral text only (no institution strings in the fork).
      if (res?.provisioned === true) {
        notifications.show({
          id: "account-provisioned",
          title: t("Your account is ready"),
          message: t(
            "You have basic access for now. To see a space, ask one of its administrators to add you.",
          ),
          autoClose: false,
          withCloseButton: true,
        });
      }
      navigate(getPostLoginRedirect());
    } finally {
      // Leave the spinner up when a full-page redirect is under way (see above); only clear it for in-SPA
      // outcomes and for any thrown/error path, where the page stays and the button must return to idle.
      if (!redirecting) setIsVerifying(false);
    }
  }

  return { requestEmail, completeSignIn, isRequesting, isVerifying, loginRoute: APP_ROUTE.AUTH.LOGIN };
}
