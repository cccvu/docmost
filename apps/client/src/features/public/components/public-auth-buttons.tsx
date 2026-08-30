import { Button, Group } from "@mantine/core";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import APP_ROUTE, { loginHrefWithReturn } from "@/lib/app-route.ts";

/**
 * The top-right "Log in / Sign up" entry for signed-out visitors. Rendered unconditionally on the
 * public front page (the visitor is anonymous by construction). Call sites where an authenticated
 * user might appear (the share shell) gate this themselves.
 *
 * "Sign up" points at the in-app request-access page — account creation is admin-approved, so this
 * sets a pending request rather than minting a usable account.
 */
export function PublicAuthButtons() {
  const { t } = useTranslation();

  return (
    <Group gap="xs" wrap="nowrap">
      <Button
        component={Link}
        to={loginHrefWithReturn()}
        variant="default"
        size="sm"
      >
        {t("Log in")}
      </Button>
      <Button
        component={Link}
        to={APP_ROUTE.AUTH.REQUEST_ACCESS}
        variant="filled"
        size="sm"
      >
        {t("Sign up")}
      </Button>
    </Group>
  );
}
