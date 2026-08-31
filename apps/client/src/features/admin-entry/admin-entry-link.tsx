import { useQuery } from "@tanstack/react-query";
import { ActionIcon, Button, Tooltip } from "@mantine/core";
import { IconShieldLock } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import platformApi from "@/lib/platform-client";

/**
 * CCC platform-admin entry point (issue #57). Fork-owned, additive UI (the client analogue of the
 * server `authz/` module): it queries the platform's `/admin/context` — same-origin, carried by the
 * `__Host-wiki_session` cookie that is present after the two-step login — and, ONLY for a platform
 * workspace admin, surfaces a link to the standalone admin console at `/console`.
 *
 * Advisory only: this gates VISIBILITY, never authority. Every action at `/console` is re-enforced
 * server-side by the PDP, and the platform admin remains a non-privileged Docmost `member` here — this
 * link grants no Docmost capability. Renders nothing for a non-admin or when there is no platform
 * session (a 401 from `/admin/context` is expected and swallowed — no redirect, no retry). `/console`
 * is served by the platform, not a Docmost SPA route, so it is a full-page navigation.
 */
export function AdminEntryLink() {
  const { t } = useTranslation();
  const { data } = useQuery({
    queryKey: ["platform-admin-context"],
    queryFn: async () => (await platformApi.get<{ isAdmin: boolean }>("/admin/context")).data,
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  if (!data?.isAdmin) return null;

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
