import { Button, Group } from "@mantine/core";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import APP_ROUTE, { loginHrefWithReturn } from "@/lib/app-route.ts";
import { isNativeAuthEnabled } from "@/features/auth-native/lib/auth-mode.ts";

/**
 * The top-right "Log in / Request access" entry for signed-out visitors. It decides where it shows by itself,
 * from the current path: a button that points at the page the visitor is on, or at its sibling auth page, is
 * hidden. On the sign-in pages (`/login…`) both go, since the sign-in body already offers "Request access",
 * and the component renders nothing at all (no empty group in the shell's header). On the request-access page
 * only "Request access" goes. Callers gate only on signed-in state, where an authenticated user might appear
 * (the share shell, the top-menu); the public front page renders it unconditionally.
 *
 * "Request access" points at the in-app request-access page, which posts to the platform's
 * `/auth/request-access` (account creation is admin-approved, so it files a pending request rather than
 * minting a usable account). Native (standalone) mode has no platform, so it shows "Log in" only.
 */
export function PublicAuthButtons() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const onLogin = pathname.startsWith(APP_ROUTE.AUTH.LOGIN);
  const onRequestAccess = pathname.startsWith(APP_ROUTE.AUTH.REQUEST_ACCESS);
  const showLogin = !onLogin;
  const showRequest = !isNativeAuthEnabled() && !onLogin && !onRequestAccess;
  if (!showLogin && !showRequest) return null;

  return (
    <Group gap="xs" wrap="nowrap">
      {showLogin && (
        <Button
          component={Link}
          to={loginHrefWithReturn()}
          variant="default"
          size="sm"
        >
          {t("Log in")}
        </Button>
      )}
      {showRequest && (
        <Button
          component={Link}
          to={APP_ROUTE.AUTH.REQUEST_ACCESS}
          variant="filled"
          size="sm"
        >
          {t("Request access")}
        </Button>
      )}
    </Group>
  );
}
