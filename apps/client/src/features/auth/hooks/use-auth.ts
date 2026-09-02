import { useState } from "react";
import {
  logout,
  setupWorkspace,
} from "@/features/auth/services/auth-service";
import { useNavigate } from "react-router-dom";
import { useAtom } from "jotai";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom";
import { ISetupWorkspace } from "@/features/auth/types/auth.types";
import { notifications } from "@mantine/notifications";
import { IAcceptInvite } from "@/features/workspace/types/workspace.types.ts";
import {
  acceptInvitation,
  createWorkspace,
} from "@/features/workspace/services/workspace-service.ts";
import APP_ROUTE from "@/lib/app-route.ts";
import { RESET } from "jotai/utils";
import { useTranslation } from "react-i18next";
import { isCloud } from "@/lib/config.ts";
import { exchangeTokenRedirectUrl, getHostnameUrl } from "@/ee/utils.ts";

// NOTE: password sign-in (`handleSignIn`/`signIn`) was removed — the platform is passwordless
// (magic link + OTP, issue #4). The two-step "mint platform session → openDocmostSession before
// navigate" now lives in features/public/hooks/use-passwordless.ts. useAuth still owns logout,
// setup, invitation, forgot/reset (Docmost-side), and verify-token.

export default function useAuth() {
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();
  const [, setCurrentUser] = useAtom(currentUserAtom);

  const handleInvitationSignUp = async (data: IAcceptInvite) => {
    setIsLoading(true);

    try {
      const response = await acceptInvitation(data);
      setIsLoading(false);

      if (response?.requiresLogin) {
        notifications.show({
          message: t(
            "Account created successfully. Please log in to set up two-factor authentication.",
          ),
        });
        navigate(APP_ROUTE.AUTH.LOGIN);
      } else {
        navigate(APP_ROUTE.HOME);
      }
    } catch (err) {
      setIsLoading(false);
      notifications.show({
        message: err.response?.data.message,
        color: "red",
      });
    }
  };

  const handleSetupWorkspace = async (data: ISetupWorkspace) => {
    setIsLoading(true);

    try {
      if (isCloud()) {
        const res = await createWorkspace(data);

        if (res?.requiresEmailVerification) {
          const hostname = res?.workspace?.hostname;
          if (hostname) {
            window.location.href =
              getHostnameUrl(hostname) +
              `/verify-email?email=${encodeURIComponent(data.email)}&sig=${res.emailSignature}`;
          }
          return;
        }

        const hostname = res?.workspace?.hostname;
        const exchangeToken = res?.exchangeToken;
        if (hostname && exchangeToken) {
          window.location.href = exchangeTokenRedirectUrl(
            hostname,
            exchangeToken,
          );
        }
      } else {
        const res = await setupWorkspace(data);
        setIsLoading(false);
        navigate(APP_ROUTE.HOME);
      }
    } catch (err) {
      setIsLoading(false);
      notifications.show({
        message: err.response?.data.message,
        color: "red",
      });
    }
  };

  const handleLogout = async () => {
    setCurrentUser(RESET);
    await logout();
    window.location.replace(`${APP_ROUTE.AUTH.LOGIN}?logout=1`);
  };

  return {
    invitationSignup: handleInvitationSignUp,
    setupWorkspace: handleSetupWorkspace,
    logout: handleLogout,
    isLoading,
  };
}
