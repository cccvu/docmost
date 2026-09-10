import { ActionIcon, Button, Tooltip } from "@mantine/core";
import { IconShieldLock } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { loginHrefWithReturn } from "@/lib/app-route";
import { usePlatformAdminContext } from "./use-platform-admin-context";

/**
 * CCC platform-admin entry point (issue #57). Fork-owned, additive UI (the client analogue of the
 * server `authz/` module): it queries the platform's `/admin/context` — same-origin, carried by the
 * `__Host-wiki_session` cookie that is present after the two-step login — and, ONLY for a platform
 * workspace admin, surfaces a link to the standalone admin console at `/console`.
 *
 * Advisory only: this gates VISIBILITY, never authority. Every action at `/console` is re-enforced
 * server-side by the PDP, and the platform admin remains a non-privileged Docmost `member` here — this
 * link grants no Docmost capability. `/console` is served by the platform, not a Docmost SPA route, so
 * it is a full-page navigation.
 *
 * The platform session is SHORTER-lived than Docmost's own session, so it can lapse while the wiki is
 * still logged in. Rather than the console entry point silently disappearing (a 401 from
 * `/admin/context` used to be swallowed to nothing — confusing for an admin who did NOT log out), a
 * recoverable failure for a browser that was previously an admin surfaces a re-authenticate affordance
 * in the same slot. See {@link usePlatformAdminContext} for the three-way state.
 */
export function AdminEntryLink() {
  const { t } = useTranslation();
  const gate = usePlatformAdminContext();

  if (gate === "hidden") return null;

  if (gate === "reauth") {
    const href = loginHrefWithReturn();
    const label = t("Admin session expired — sign in again");
    return (
      <>
        <Tooltip label={label} openDelay={250} withArrow>
          <Button
            component="a"
            href={href}
            variant="subtle"
            color="gray"
            size="sm"
            leftSection={<IconShieldLock size={18} stroke={1.5} />}
            visibleFrom="sm"
            aria-label={label}
          >
            {t("Sign in")}
          </Button>
        </Tooltip>
        <Tooltip label={label} openDelay={250} withArrow>
          <ActionIcon
            component="a"
            href={href}
            variant="subtle"
            color="gray"
            size="sm"
            hiddenFrom="sm"
            aria-label={label}
          >
            <IconShieldLock size={20} stroke={1.5} />
          </ActionIcon>
        </Tooltip>
      </>
    );
  }

  return (
    <>
      <Button
        component="a"
        href="/console"
        variant="subtle"
        color="gray"
        size="sm"
        leftSection={<IconShieldLock size={18} stroke={1.5} />}
        visibleFrom="sm"
      >
        {t("Admin")}
      </Button>
      <Tooltip label={t("Admin")} openDelay={250} withArrow>
        <ActionIcon
          component="a"
          href="/console"
          variant="subtle"
          color="gray"
          size="sm"
          hiddenFrom="sm"
          aria-label={t("Admin")}
        >
          <IconShieldLock size={20} stroke={1.5} />
        </ActionIcon>
      </Tooltip>
    </>
  );
}
