import { useAtom, useSetAtom } from "jotai";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom";
import React, { useEffect, useState } from "react";
import useCurrentUser from "@/features/user/hooks/use-current-user";
import { useTranslation } from "react-i18next";
import { socketAtom } from "@/features/websocket/atoms/socket-atom.ts";
import { io } from "socket.io-client";
import { SOCKET_URL } from "@/features/websocket/types";
import { useQuerySubscription } from "@/features/websocket/use-query-subscription.ts";
import { useTreeSocket } from "@/features/websocket/use-tree-socket.ts";
import { useNotificationSocket } from "@/features/notification/hooks/use-notification-socket.ts";
import { useCollabToken } from "@/features/auth/queries/auth-query.tsx";
import { Error404 } from "@/components/ui/error-404.tsx";
import { useEntitlements } from "@/ee/entitlement/use-entitlements";
import { entitlementAtom } from "@/ee/entitlement/entitlement-atom";
import { changeAppLanguage } from "@/lib/date-locale.ts";
import { useIdentityReconcile } from "@/features/identity-reconcile/use-identity-reconcile";
import { useSocketAuthProbe } from "@/features/websocket/use-socket-auth-probe";
import { loginHrefWithReturn } from "@/lib/app-route.ts";

export function UserProvider({ children }: React.PropsWithChildren) {
  const [currentUser, setCurrentUser] = useAtom(currentUserAtom);
  // CCC (wiki-v2 #917): true once THIS load has stored the /users/me answer (see the gate below).
  const [stored, setStored] = useState(false);
  const setEntitlements = useSetAtom(entitlementAtom);
  const { data, isLoading, error, isError } = useCurrentUser();
  const { data: entitlements } = useEntitlements();
  const { i18n } = useTranslation();
  const [, setSocket] = useAtom(socketAtom);
  // fetch collab token on load
  const { data: collab } = useCollabToken();

  useEffect(() => {
    if (isLoading || isError) {
      return;
    }

    const newSocket = io(SOCKET_URL, {
      transports: ["websocket"],
      withCredentials: true,
    });

    // @ts-ignore
    setSocket(newSocket);

    newSocket.on("connect", () => {
      console.log("ws connected");
    });

    return () => {
      console.log("ws disconnected");
      newSocket.disconnect();
    };
  }, [isError, isLoading]);

  useQuerySubscription();
  useTreeSocket();
  useNotificationSocket();
  useSocketAuthProbe(); // wiki-v2 #830
  useIdentityReconcile(data?.user?.id); // wiki-v2 #761

  useEffect(() => {
    if (data && data.user && data.workspace) {
      setCurrentUser(data);
      setStored(true); // CCC (wiki-v2 #917): batched with the store, one render
      const lng = data.user.locale === "en" ? "en-US" : data.user.locale;
      // #408: changeAppLanguage loads the date-fns locale BEFORE switching language, so date-showing
      // components render the correct locale on their first render for `lng` (getDateFnsLocale stays
      // synchronous, zero flash). Never call i18n.changeLanguage directly here.
      void changeAppLanguage(lng);
    } else if (data) {
      // CCC (wiki-v2 #917): the gate below stays blank; say why instead of failing silently.
      console.warn(
        "UserProvider: /users/me returned no user or workspace; the signed-in tree stays hidden",
      );
    }
  }, [data, isLoading]);

  // CCC (wiki-v2 #917): another tab signed out (it cleared the "currentUser" key that
  // current-user-atom.ts stores, or all of localStorage), so this tab's tree is now blank: send it to
  // login, back here after sign-in. `storage` fires only in OTHER documents, so a same-tab clear (the
  // logout handler, which then POSTs and redirects itself) never lands here.
  useEffect(() => {
    if (!stored) return;
    const onStorage = (e: StorageEvent) => {
      if (e.storageArea !== window.localStorage || e.newValue !== null) return;
      if (e.key !== "currentUser" && e.key !== null) return;
      window.location.replace(loginHrefWithReturn());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [stored]);

  useEffect(() => {
    document.documentElement.lang = i18n.resolvedLanguage || i18n.language || "en-US";
  }, [i18n.language, i18n.resolvedLanguage]);

  useEffect(() => {
    if (entitlements) {
      setEntitlements(entitlements);
    }
  }, [entitlements]);

  if (isLoading) return <></>;

  if (isError && error?.["response"]?.status === 404) {
    return <Error404 />;
  }

  if (error) {
    return <></>;
  }

  // CCC (wiki-v2 #911, #917): the effect above stores the loaded user after this render, and the atom
  // starts null when nothing is stored (fresh profile, after sign-out) or holds a previous session's copy.
  // Children read `userAtom` as non-null and seed local state from it once, so render them only once it
  // holds the user THIS load stored. Clearing the atom later (sign-out) unmounts them again.
  if (!stored || !currentUser) {
    return <></>;
  }

  return <>{children}</>;
}
