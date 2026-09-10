import { useQuery } from "@tanstack/react-query";
import type { AxiosError } from "axios";
import platformApi from "@/lib/platform-client";

/**
 * Advisory, browser-local hint that this browser has, at least once, been observed as a platform
 * workspace admin. It is NEVER authority (the server re-derives `isAdmin` on every `/admin/context`
 * request via a fully-consistent PDP check) — it only lets the header distinguish "genuine non-admin"
 * from "was an admin, but the platform session lapsed" so the latter gets a re-authenticate affordance
 * instead of the console entry point silently vanishing. Cleared on logout. See admin-entry-link.tsx.
 */
export const PLATFORM_ADMIN_SEEN_KEY = "ccc.platformAdminSeen";

export function rememberPlatformAdminSeen(): void {
  try {
    localStorage.setItem(PLATFORM_ADMIN_SEEN_KEY, "1");
  } catch {
    // Private-mode / disabled storage: the hint is advisory, so proceed without it.
  }
}

export function clearPlatformAdminSeen(): void {
  try {
    localStorage.removeItem(PLATFORM_ADMIN_SEEN_KEY);
  } catch {
    // ignore — see rememberPlatformAdminSeen
  }
}

function hasSeenPlatformAdmin(): boolean {
  try {
    return localStorage.getItem(PLATFORM_ADMIN_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * A lapsed/rotated platform session surfaces as 401; a transient PDP or Redis (ElastiCache) blip
 * surfaces as 5xx; a dropped connection has no response. All three are RECOVERABLE by
 * re-authenticating. A clean 200 `{isAdmin:false}` is a genuine non-admin and is handled by the
 * `data` branch below — it never reaches here — so only auth/transport failures count as recoverable.
 */
function isRecoverableError(error: unknown): boolean {
  const status = (error as AxiosError | null)?.response?.status;
  if (status == null) return true;
  return status === 401 || status >= 500;
}

export type PlatformAdminGate = "admin" | "hidden" | "reauth";

/**
 * Resolves the three-way visibility state for the admin console entry point.
 *
 * - `admin`  — a `200 {isAdmin:true}` (kept as last-good `data` even during a background-refetch
 *              error, so a transient blip never blanks the link while the session is still valid).
 * - `hidden` — a genuine non-admin (`200 {isAdmin:false}`), the initial load, or an unrecoverable /
 *              un-hinted error (a non-admin whose session simply lapsed shows nothing).
 * - `reauth` — the browser was previously an admin but the request failed recoverably (session
 *              lapse / transient blip / network), so the console session must be re-established.
 *
 * `gcTime: Infinity` keeps the last-good result across header unmount/remount within a page session
 * (killing the empty-cache-remount blank), and the refetch triggers let the link self-heal the moment
 * a valid session returns — a failed background refetch keeps `data`, so these are purely additive.
 */
export function usePlatformAdminContext(): PlatformAdminGate {
  const { data, error, isError } = useQuery({
    queryKey: ["platform-admin-context"],
    queryFn: async () => {
      const res = await platformApi.get<{ isAdmin: boolean }>("/admin/context");
      // Keep the advisory hint in sync with the authoritative answer: set it when admin, and CLEAR it on a
      // genuine 200 {isAdmin:false} — so a demoted former admin stops getting the re-authenticate affordance.
      if (res.data?.isAdmin) rememberPlatformAdminSeen();
      else clearPlatformAdminSeen();
      return res.data;
    },
    retry: false,
    staleTime: 5 * 60 * 1000,
    gcTime: Infinity,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  if (data?.isAdmin) return "admin";
  if (data) return "hidden";
  if (isError && isRecoverableError(error) && hasSeenPlatformAdmin()) return "reauth";
  return "hidden";
}
