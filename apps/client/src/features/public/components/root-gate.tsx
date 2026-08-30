import { Navigate } from "react-router-dom";
import { Center, Loader } from "@mantine/core";
import useCurrentUser from "@/features/user/hooks/use-current-user.ts";
import APP_ROUTE from "@/lib/app-route.ts";
import PublicHome from "@/pages/public/public-home.tsx";

/**
 * The "/" gate. Reuses the shared `["currentUser"]` query (retry disabled globally), so:
 *  - a signed-in visitor resolves to their cached user and is sent to /home unchanged (UserProvider
 *    then reuses the same cached result — no double fetch, no login-wall bounce);
 *  - an anonymous visitor's /users/me returns 401 (the interceptor does NOT redirect on "/"), so we
 *    render the public landing.
 */
export default function RootGate() {
  const { data, isLoading } = useCurrentUser();

  if (isLoading) {
    return (
      <Center h="100vh">
        <Loader aria-label="Loading" />
      </Center>
    );
  }

  if (data?.user) {
    return <Navigate to={APP_ROUTE.HOME} replace />;
  }

  return <PublicHome />;
}
