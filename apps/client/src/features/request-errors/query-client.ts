import { QueryCache, QueryClient } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import i18n from "i18next";
import {
  isRateLimited,
  requestErrorMessage,
  retryAfterMs,
  type Translate,
} from "./request-error";

// #384: the fork's per-principal limiter blocks for ~10 s, so one retry after its Retry-After usually lands.
// The WAF's 60 s window (shared NAT, 5-min evaluation) is not worth waiting on silently: show it at once.
export const MAX_AUTO_RETRY_AFTER_MS = 10_000;
const RETRY_JITTER_MS = 1_000;
export const RATE_LIMITED_NOTIFICATION_ID = "ccc-rate-limited";

// TanStack calls this with the failures so far (0 on the first), so `failureCount === 0` is exactly one retry.
export function shouldRetryQuery(
  failureCount: number,
  error: unknown,
): boolean {
  if (failureCount > 0 || !isRateLimited(error)) return false;
  const ms = retryAfterMs(error);
  return ms !== null && ms <= MAX_AUTO_RETRY_AFTER_MS;
}

// Never earlier than the server asked; the jitter spreads tabs that were limited together.
export function queryRetryDelay(_failureCount: number, error: unknown): number {
  const base = retryAfterMs(error) ?? RETRY_JITTER_MS;
  return base + Math.floor(Math.random() * RETRY_JITTER_MS);
}

// `i18n.t` is an unbound class method; call it through the instance.
const translate: Translate = (key, options) => i18n.t(key, options);

function notifyRateLimited(error: unknown) {
  // One toast however many queries a page fires: Mantine skips a show() whose id is already in the store.
  // Mutations are not covered here; they keep their own error toasts, so nothing doubles.
  notifications.show({
    id: RATE_LIMITED_NOTIFICATION_ID,
    color: "yellow",
    title: translate("Too many requests"),
    message: requestErrorMessage(error, translate, ""),
  });
}

export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => {
        if (isRateLimited(error)) notifyRateLimited(error);
      },
    }),
    defaultOptions: {
      queries: {
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        // Queries that set their own `retry` (e.g. the collab token) keep it.
        retry: shouldRetryQuery,
        retryDelay: queryRetryDelay,
        staleTime: 5 * 60 * 1000,
      },
    },
  });
}
