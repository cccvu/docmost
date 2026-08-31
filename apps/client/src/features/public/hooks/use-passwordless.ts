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
  async function requestEmail(email: string): Promise<boolean> {
    setIsRequesting(true);
    try {
      await requestPasswordless({ email });
      return true;
    } catch {
      notifications.show({
        color: "red",
        message: t("We couldn't send a sign-in email right now. Please try again in a moment."),
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
    try {
      await verifyPasswordless(args); // throws => invalid / expired / already-used code or link
      // Two-step: establish the Docmost session before navigating; roll back the platform session on
      // failure so a half-authenticated state never persists.
      try {
        await openDocmostSession();
      } catch {
        await logout().catch(() => undefined);
        throw Object.assign(new Error("session-bridge-failed"), { stage: "bridge" as const });
      }
      navigate(getPostLoginRedirect());
    } finally {
      setIsVerifying(false);
    }
  }

  return { requestEmail, completeSignIn, isRequesting, isVerifying, loginRoute: APP_ROUTE.AUTH.LOGIN };
}
