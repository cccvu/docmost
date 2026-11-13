import AccountNameForm from "@/features/user/components/account-name-form";
import ChangeEmail from "@/features/user/components/change-email";
import { Divider } from "@mantine/core";
import AccountAvatar from "@/features/user/components/account-avatar";
import SettingsTitle from "@/components/settings/settings-title.tsx";
import { getAppName } from "@/lib/config.ts";
import { Helmet } from "react-helmet-async";
import { useTranslation } from "react-i18next";
import SessionList from "@/features/session/components/session-list";
// CCC (wiki-v2 UI cleanup): the platform owns the email in remote mode.
import { isNativeAuthEnabled } from "@/features/auth-native/lib/auth-mode.ts";
// CCC (wiki-v2 #818): Profile → Passkeys (fork-owned; renders its own divider, and nothing without passkeys).
import PasskeysSection from "@/features/passkeys/components/passkeys-section.tsx";

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

      {/* CCC (wiki-v2 UI cleanup): Email is native-only; in remote mode it is the platform's synthetic
          shadow address. Sessions stay in both modes: "Log out of all devices" is the only self-service way
          to end the wiki sessions on other devices (ADR 0034 residuals). The always-null EE MFA section
          (ADR 0035) is not mounted. */}
      {isNativeAuthEnabled() && (
        <>
          <Divider my="lg" />

          <ChangeEmail />
        </>
      )}

      <Divider my="lg" />

      <SessionList />

      <PasskeysSection />
    </>
  );
}
