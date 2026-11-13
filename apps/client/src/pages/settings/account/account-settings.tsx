import AccountNameForm from "@/features/user/components/account-name-form";
import ChangeEmail from "@/features/user/components/change-email";
import { Divider } from "@mantine/core";
import AccountAvatar from "@/features/user/components/account-avatar";
import SettingsTitle from "@/components/settings/settings-title.tsx";
import { getAppName } from "@/lib/config.ts";
import { Helmet } from "react-helmet-async";
import { useTranslation } from "react-i18next";
import SessionList from "@/features/session/components/session-list";
// CCC (wiki-v2 UI cleanup): the platform owns email and sessions in remote mode.
import { isNativeAuthEnabled } from "@/features/auth-native/lib/auth-mode.ts";

export default function AccountSettings() {
  const { t } = useTranslation();

  return (
    <>
      <Helmet>
        <title>
          {t("My Profile")} - {getAppName()}
        </title>
      </Helmet>
      <SettingsTitle title={t("My Profile")} />

      <AccountAvatar />

      <AccountNameForm />

      {/* CCC (wiki-v2 UI cleanup): Email and Sessions are native-only. In remote mode the email is the
          platform's synthetic shadow address, and revoking a session ends only the wiki token, which the
          platform session silently re-mints. The always-null EE MFA section (ADR 0035) is not mounted. */}
      {isNativeAuthEnabled() && (
        <>
          <Divider my="lg" />

          <ChangeEmail />

          <Divider my="lg" />

          <SessionList />
        </>
      )}
    </>
  );
}
