import SettingsTitle from "@/components/settings/settings-title.tsx";
import WorkspaceNameForm from "@/features/workspace/components/settings/components/workspace-name-form";
import WorkspaceIcon from "@/features/workspace/components/settings/components/workspace-icon.tsx";
import { useTranslation } from "react-i18next";
import { getAppName, isCloud } from "@/lib/config.ts";
import { Helmet } from "react-helmet-async";
import ManageHostname from "@/ee/components/manage-hostname.tsx";
import { Divider, Text } from "@mantine/core";
import AllowMemberTemplates from "@/ee/security/components/allow-member-templates.tsx";
import WorkspaceDefaultPageEditMode from "@/features/workspace/components/settings/components/workspace-default-page-edit-mode.tsx";
import PersonalSpacesSetting from "@/ee/personal-space/components/personal-spaces-setting.tsx";
import useUserRole from "@/hooks/use-user-role.tsx";
import { FeatureGate } from "@/features/feature-availability/feature-gate.tsx";
import { Feature } from "@/ee/features";

export default function WorkspaceSettings() {
  const { t } = useTranslation();
  // CCC: every editable control here writes through Docmost's manage-settings
  // ability (POST /workspace/update). Platform admins are deliberately non-
  // privileged Docmost members, so they manage these in the Admin Console; only a
  // Docmost workspace admin/owner sees the editable controls here (defense-in-depth
  // for a direct URL — the nav item is already role-gated in settings-sidebar).
  const { isAdmin } = useUserRole();

  return (
    <>
      <Helmet>
        <title>Workspace Settings - {getAppName()}</title>
      </Helmet>
      <SettingsTitle title={t("General")} />

      {!isAdmin ? (
        <Text size="sm" c="dimmed">
          {t("Workspace settings are managed by administrators.")}
        </Text>
      ) : (
        <>
          <WorkspaceIcon />
          <WorkspaceNameForm />

          {/* CCC: paid toggles are HIDDEN when unavailable (were greyed with an
              "Available with a paid license" tooltip). */}
          <FeatureGate feature={Feature.TEMPLATES}>
            <Divider my="md" />
            <AllowMemberTemplates />
          </FeatureGate>

          <FeatureGate feature={Feature.PERSONAL_SPACES}>
            <Divider my="md" />
            <PersonalSpacesSetting />
          </FeatureGate>

          {isCloud() && (
            <>
              <Divider my="md" />
              <ManageHostname />
            </>
          )}

          <Divider my="md" />
          <WorkspaceDefaultPageEditMode />
        </>
      )}
    </>
  );
}
