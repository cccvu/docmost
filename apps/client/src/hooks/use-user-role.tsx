import { useAtom } from "jotai";
import { UserRole } from "@/lib/types.ts";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom.ts";
import { isNativeAuthEnabled } from "@/features/auth-native/lib/auth-mode.ts";

export const useUserRole = () => {
  const [currentUser] = useAtom(currentUserAtom);

  // CCC (wiki-v2 #636): in remote mode the server ignores `users.role` (every role gets the member workspace
  // ability) and refuses the native admin routes, so an owner/admin role here would only show controls that fail.
  // Workspace administration lives in the Admin Console.
  const role = isNativeAuthEnabled()
    ? currentUser?.user?.role
    : UserRole.MEMBER;

  const isAdmin = role === UserRole.ADMIN || role === UserRole.OWNER;

  const isOwner = role === UserRole.OWNER;

  const isMember = role === UserRole.MEMBER;

  return { isAdmin, isOwner, isMember };
};

export default useUserRole;
