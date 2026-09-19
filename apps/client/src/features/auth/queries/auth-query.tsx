import { useQuery, UseQueryResult } from "@tanstack/react-query";
import type { AxiosError } from "axios";
import { getCollabToken } from "../services/auth-service";
import { ICollabToken } from "../types/auth.types";

// #385: retry only transient failures — a cold-start / rolling-deploy race (5xx or no response) and a rate
// limit (429), honoring a Retry-After when the edge sends one. Deliberate refusals (403/404 and any other
// 4xx) are terminal: retrying cannot help and only amplifies an edge control. Bounded so a persistent
// failure can't loop forever (the stock override returned a truthy `10` from a *function* → unbounded, and
// read `error.response.status` unguarded → threw a TypeError on a network error, the very cold-start case
// it existed to survive).
export const COLLAB_TOKEN_MAX_RETRIES = 4; // one above React Query's default of 3, for the cold-start race

export function shouldRetryCollabToken(
  failureCount: number,
  error: unknown,
): boolean {
  if (failureCount >= COLLAB_TOKEN_MAX_RETRIES) return false;
  // Guarded read: a network error is an AxiosError with NO `response`, so `.status` must not be read
  // blindly (mirrors isRecoverableError in features/admin-entry/use-platform-admin-context.ts).
  const status = (error as AxiosError | null)?.response?.status;
  if (status == null) return true; // network error (no response) — the cold-start race
  return status === 429 || status >= 500; // rate limit + server errors; every other 4xx is terminal
}

export function collabTokenRetryDelay(
  failureCount: number,
  error: unknown,
): number {
  // Honor Retry-After (delta-seconds) when present — a 429, or a 503 that carries it. Retry-After is a
  // MINIMUM: wait at least that long. Jitter is added ON TOP (never a down-clamp), so the wait is always
  // >= the server's value and we never retry early; the overall loop is bounded by the attempt cap above.
  // Otherwise fall back to React Query's own default backoff (capped exponential).
  const retryAfterSec = Number(
    (error as AxiosError | null)?.response?.headers?.["retry-after"],
  );
  if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    return retryAfterSec * 1000 + Math.random() * 15_000;
  }
  return Math.min(1000 * 2 ** failureCount, 30_000);
}

export function useCollabToken(): UseQueryResult<ICollabToken, Error> {
  // Pin TError to Error: the retry/retryDelay predicates take `error: unknown` (they guard the axios shape
  // themselves), which would otherwise make useQuery infer TError as `unknown`.
  return useQuery<ICollabToken, Error>({
    queryKey: ["collab-token"],
    queryFn: () => getCollabToken(),
    staleTime: 20 * 60 * 60 * 1000, //20hrs
    //refetchInterval: 12 * 60 * 60 * 1000, // 12hrs
    //refetchIntervalInBackground: true,
    refetchOnMount: true,
    retry: shouldRetryCollabToken,
    retryDelay: collabTokenRetryDelay,
  });
}
