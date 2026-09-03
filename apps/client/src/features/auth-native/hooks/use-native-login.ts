import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import { useAtom } from "jotai";
import { RESET } from "jotai/utils";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom";
import APP_ROUTE from "@/lib/app-route";
import { nativeLogin } from "../services/native-auth-service";

/**
 * CCC native (standalone) sign-in hook — NOT upstream Docmost code. Posts credentials to Docmost's own
 * login, then resets the cached user so `UserProvider`'s `/api/users/me` refetches under the fresh
 * `authToken` cookie, and navigates home. On failure it surfaces the server message.
 */
export function useNativeLogin() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);
  const [, setCurrentUser] = useAtom(currentUserAtom);

  async function signIn(email: string, password: string): Promise<void> {
    setIsLoading(true);
    try {
      await nativeLogin({ email: email.trim(), password });
      setCurrentUser(RESET);
      navigate(APP_ROUTE.HOME);
    } catch (err) {
      const message =
        (err as { response?: { data?: { message?: string } } })?.response?.data
          ?.message ?? t("Invalid email or password.");
      notifications.show({ color: "red", message });
    } finally {
      setIsLoading(false);
    }
  }

  return { signIn, isLoading };
}
