import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDisclosure } from "@mantine/hooks";
import { isNativeAuthEnabled } from "@/features/auth-native/lib/auth-mode";
import { errorStatus } from "@/features/request-errors/request-error";
import { getFeedbackStatus } from "./feedback-service";

export const FEEDBACK_STATUS_QUERY_KEY = ["feedback-status"] as const;

export interface FeedbackEntry {
  /** Show the "Send feedback" menu item. */
  visible: boolean;
  /** The status probe answered 401: the platform session lapsed, so the modal leads with "Sign in again". */
  needsSignIn: boolean;
  /** Pass to the account `<Menu onChange>`: the status probe runs on the first open, not on page load. */
  onMenuChange: (opened: boolean) => void;
  opened: boolean;
  open: () => void;
  close: () => void;
}

/**
 * Visibility + open state for the avatar-menu feedback entry (#764). Advisory only: the platform decides
 * every submission. Hidden in standalone/native mode (there is no platform) and when the platform says the
 * feature is off (`enabled:false`). While the probe is in flight, or when it fails for any other reason, the
 * item stays visible — the modal reports the real outcome of a send.
 */
export function useFeedbackEntry(): FeedbackEntry {
  const native = isNativeAuthEnabled();
  const [menuSeen, setMenuSeen] = useState(false);
  const [opened, { open, close }] = useDisclosure(false);

  const status = useQuery({
    queryKey: FEEDBACK_STATUS_QUERY_KEY,
    queryFn: getFeedbackStatus,
    enabled: menuSeen && !native,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  // First open enables the query; a later open re-checks once the answer is older than staleTime.
  const onMenuChange = (isOpen: boolean) => {
    if (!isOpen || native) return;
    setMenuSeen(true);
    if (menuSeen && status.isStale && !status.isFetching) void status.refetch();
  };

  return {
    visible: !native && status.data?.enabled !== false,
    needsSignIn: errorStatus(status.error) === 401,
    onMenuChange,
    opened,
    open,
    close,
  };
}
