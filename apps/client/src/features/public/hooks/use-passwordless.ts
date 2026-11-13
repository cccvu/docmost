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
import {
  isRateLimited,
  tooManyRequestsMessage,
} from "@/features/public/otp-code.ts";
import { retryAfterMs } from "@/features/request-errors/request-error.ts";
import { platformAuthenticatorAvailable } from "@/features/passkeys/lib/capabilities.ts";
import { isPasskeyNudgeDismissed } from "@/features/passkeys/lib/nudge-storage.ts";

/**
 * What a verifier answers: the platform's sign-in verify body (email code or link, `IPasswordlessVerifyResponse`; or
 * passkey, `PasskeySignInResponse`). Only the members the shared tail reads are named.
 */
export interface VerifiedSignIn {
  /** #302: an MCP OAuth flow is parked for this browser; resume it instead of entering the wiki. */
  resume?: boolean;
  /** #797: this sign-in created or first activated the account. Email path only. */
  provisioned?: boolean;
  /** #818: passkey path only; days left (1–30) before the email proof that keeps passkeys working lapses. */
  emailConfirmationDueDays?: number;
}

/** How the person proved who they are. Picks the post-sign-in screen: a nudge after email, a reminder after passkey. */
export type SignInMethod = "email" | "passkey";

/**
 * #818: a full-page screen shown AFTER the wiki session is open and BEFORE navigating. Never on an OAuth resume.
 *  - nudge: after an email sign-in, on a device with a built-in authenticator, unless dismissed on this device.
 *  - reminder: after a passkey sign-in whose email proof lapses within 30 days.
 */
export type PostSignInScreen =
  | { kind: "nudge" }
  | { kind: "reminder"; daysLeft: number };

export interface SignInOptions {
  /**
   * Offer the #818 post-sign-in screens. The caller must then render `postSignIn` and call `continueAfterSignIn`.
   * Off by default, so a page that does not render them (the magic-link page) navigates exactly as before.
   */
  screens?: boolean;
}

// A built-in-authenticator probe that never answers must not hold a signed-in person on the login page.
const PLATFORM_AUTHENTICATOR_PROBE_MS = 1500;

async function hasPlatformAuthenticator(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      platformAuthenticatorAvailable(),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(
          () => resolve(false),
          PLATFORM_AUTHENTICATOR_PROBE_MS,
        );
      }),
    ]);
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The #818 screen for this sign-in, or null to navigate straight away. Never throws. */
async function choosePostSignInScreen(
  method: SignInMethod,
  res: VerifiedSignIn | undefined,
): Promise<PostSignInScreen | null> {
  if (method === "passkey") {
    const days = res?.emailConfirmationDueDays;
    return typeof days === "number" &&
      Number.isInteger(days) &&
      days >= 1 &&
      days <= 30
      ? { kind: "reminder", daysLeft: days }
      : null;
  }
  if (isPasskeyNudgeDismissed()) return null;
  return (await hasPlatformAuthenticator()) ? { kind: "nudge" } : null;
}

/**
 * Passwordless sign-in orchestration (magic link + OTP, and #818 passkeys through `completeSignInWith`). Reuses the SAME two-step the password login
 * used (see use-auth.ts): a verified passwordless sign-in only sets the PLATFORM session, so we must
 * openDocmostSession() (the BFF bridge) BEFORE navigating, and roll the platform session back if that
 * bridge fails — otherwise the app mounts with a live platform cookie but 401ing Docmost /api/* calls.
 */
export function usePasswordless() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [isRequesting, setIsRequesting] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [postSignIn, setPostSignIn] = useState<PostSignInScreen | null>(null);

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
          : t(
              "We couldn't send a sign-in email right now. Please try again in a moment.",
            ),
      });
      return false;
    } finally {
      setIsRequesting(false);
    }
  }

  // The shared post-verify tail (#818: a pluggable verifier). Every sign-in method runs the SAME order: verify →
  // open the wiki session (the BFF mint) → OAuth resume, or the post-sign-in screen, or navigate. Throws are surfaced
  // to the caller (which shows the message) so a page can render an inline error without a redirect loop. The two
  // failure modes are DISTINGUISHED: a `verify` throw means the credential was refused (an invalid/expired/used code
  // or link, or a refused passkey), while a bridge failure (the credential WAS good) is re-thrown tagged
  // `stage: "bridge"` so the page shows a "verified but couldn't open your session" message instead.
  //
  // `verify` is CALLED SYNCHRONOUSLY, before this function's first await. A passkey verifier runs its one native
  // options fetch and then `get()` from the click that called this (Safari's user-gesture rule, #818 contract §5.1):
  // an await in front of `verify()` here would spend that gesture.
  async function completeSignInWith(
    verify: () => Promise<VerifiedSignIn>,
    opts: SignInOptions & { method: SignInMethod },
  ): Promise<void> {
    setIsVerifying(true);
    // On the resume branch we hand off to a FULL-PAGE navigation, which does not tear the page down
    // synchronously — so clearing `isVerifying` in `finally` would re-enable the sign-in button mid-navigation
    // and invite a double-submit that re-verifies an already-consumed OTP/token (a confusing "invalid code"
    // flash). Keep the spinner up through the redirect, matching use-auth.ts (#302 review, Frontend).
    let redirecting = false;
    try {
      const res = await verify(); // throws => the credential was refused

      // OAuth resume (#302): this browser began an MCP OAuth flow before signing in. The pending
      // /oauth/authorize request is parked server-side; we must return to it with a FULL-PAGE navigation
      // (it is a platform route, not an SPA route — React-Router navigate() would 404). Establish the Docmost
      // session best-effort so any later same-browser wiki use works, but a bridge failure here is NON-FATAL:
      // OAuth consent needs only the platform session, and rolling back (logout) would wipe the very session
      // the resume depends on. So on resume we never call logout() on a bridge failure. No #818 screen either:
      // the person is in the middle of connecting an app, and the resume must not wait on a click.
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
        throw Object.assign(new Error("session-bridge-failed"), {
          stage: "bridge" as const,
        });
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
      // #818: the nudge or the reminder, AFTER the wiki session is open (both screens call the platform as the
      // signed-in person) and before navigating. The page renders it and calls continueAfterSignIn().
      if (opts.screens === true) {
        const screen = await choosePostSignInScreen(opts.method, res);
        if (screen) {
          setPostSignIn(screen);
          return;
        }
      }
      navigate(getPostLoginRedirect());
    } finally {
      // Leave the spinner up when a full-page redirect is under way (see above); only clear it for in-SPA
      // outcomes and for any thrown/error path, where the page stays and the button must return to idle.
      if (!redirecting) setIsVerifying(false);
    }
  }

  // Complete an email sign-in, from either channel (the emailed code, or the link).
  async function completeSignIn(
    args: { token: string } | { email: string; otp: string },
    opts: SignInOptions = {},
  ): Promise<void> {
    return completeSignInWith(() => verifyPasswordless(args), {
      ...opts,
      method: "email",
    });
  }

  // #818: leave the post-sign-in screen for the page the person was going to.
  function continueAfterSignIn(): void {
    setPostSignIn(null);
    navigate(getPostLoginRedirect());
  }

  return {
    requestEmail,
    completeSignIn,
    completeSignInWith,
    continueAfterSignIn,
    postSignIn,
    isRequesting,
    isVerifying,
    loginRoute: APP_ROUTE.AUTH.LOGIN,
  };
}
