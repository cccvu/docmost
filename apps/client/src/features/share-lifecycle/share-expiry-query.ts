// CCC (fork-owned): TanStack Query wrappers for the share expiry API (#335).
import {
  useMutation,
  useQuery,
  useQueryClient,
  UseQueryResult,
} from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import {
  getShareExpiry,
  ISetShareExpiry,
  IShareExpiry,
  setShareExpiry,
} from "./share-expiry-service";

export const SHARE_EXPIRY_QUERY_KEY = "share-expiry";

export function shareExpiryQueryKey(shareId: string | undefined) {
  return [SHARE_EXPIRY_QUERY_KEY, shareId] as const;
}

/** HTTP status of an api-client (axios) error, or undefined. */
export function errorStatus(error: unknown): number | undefined {
  const e = error as { status?: number; response?: { status?: number } };
  return e?.response?.status ?? e?.status;
}

/**
 * The effective expiry of one share. Keyed by share id, so a new share (first publish, or a re-share after
 * expiry or unpublish) is a new key and is fetched fresh; it refetches whenever the share modal re-mounts,
 * so a change made elsewhere shows up on the next open. Pass `undefined` to disable (native mode, not a
 * direct share, ...).
 */
export function useShareExpiryQuery(
  shareId: string | undefined,
): UseQueryResult<IShareExpiry, Error> {
  return useQuery({
    queryKey: shareExpiryQueryKey(shareId),
    queryFn: () => getShareExpiry(shareId as string),
    enabled: !!shareId,
    staleTime: 0,
    refetchOnMount: true,
    retry: false,
  });
}

export function useSetShareExpiryMutation() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation<IShareExpiry, Error, ISetShareExpiry>({
    mutationFn: (data) => setShareExpiry(data),
    onSuccess: (data, vars) => {
      queryClient.setQueryData(shareExpiryQueryKey(vars.shareId), data);
      notifications.show({ message: t("Link expiry updated") });
    },
    onError: (error, vars) => {
      if (errorStatus(error) === 404) {
        // The share is gone (expired, unpublished, or no longer shareable): drop what we cached for it so the
        // Publish tab re-reads the page's share state.
        queryClient.removeQueries({ queryKey: shareExpiryQueryKey(vars.shareId) });
        queryClient.invalidateQueries({ queryKey: ["share-for-page"] });
        notifications.show({ message: t("Share not found"), color: "red" });
        return;
      }
      notifications.show({
        message:
          error?.["response"]?.data?.message ||
          t("Failed to update link expiry"),
        color: "red",
      });
    },
  });
}
