// wiki-v2 #939 — NOT upstream Docmost code. The site announcement's state, shared by the shell (header height) and
// the banner: each shell calls `useAnnouncement()` ONCE and passes the result to <AnnouncementBanner>, so a
// dismissal hides the strip and shrinks the header in the same render.
//
// Fetching: the platform's public `GET /bff/announcement` (no auth; `Cache-Control: no-store`), polled every 60 s
// while the tab is visible and on focus and reconnect. A raw `fetch`, not `platformApi`: the global query-cache
// handler raises its "Too many requests" toast for an axios 429, and a background poll must never do that. Only a
// 200 `application/json` answer with the contract's shape replaces the data; anything else (Docmost's SPA fallback
// `200 text/html`, a 404 from an older platform during a rolling deploy, a 503) throws, and TanStack keeps the
// last good answer. That answer is trusted for MAX_STALE_MS after it arrived, or past that while a refetch is in
// flight (each request has a 10 s deadline, so a hang ends as a failure), and then hidden (the fail-safe: once a refetch has failed, the banner never outlives a cancellation by more
// than that). Nothing is persisted, so a reload starts clean.
//
// Time: `now` is state, read from the clock only in a lazy initialiser, a timer and a `visibilitychange` callback
// (fork lint enforces `react-hooks/purity`, so never `Date.now()` during render). One timer is armed at the next
// boundary (start, downtime start, end, staleness), so the banner changes phase and hides on time in a tab left
// open. Native (standalone) mode has no platform, so it never fetches.

import { useCallback, useEffect, useState } from "react";
import { useIsFetching, useQuery } from "@tanstack/react-query";
import { isNativeAuthEnabled } from "@/features/auth-native/lib/auth-mode";
import { HEADER_HEIGHT } from "@/features/layout/layout-tokens";
import { parseAnnouncementBody, type Announcement } from "./announcement-contract";
import {
  type AnnouncementPhase,
  isDismissible,
  isFresh,
  nextBoundary,
  phaseOf,
} from "./announcement-schedule";
import { readDismissedVersion, storeDismissedVersion } from "./announcement-storage";

export const ANNOUNCEMENT_PATH = "/bff/announcement";
export const ANNOUNCEMENT_QUERY_KEY = ["site-announcement"] as const;

/** The banner strip's fixed height (px). One line, so the header height is a constant sum. */
export const BANNER_HEIGHT = 40;

/** setTimeout fires at once for delays above 2^31-1 ms, so a far boundary is reached in capped steps. */
export const MAX_TIMER_MS = 2 ** 31 - 2;

export interface AnnouncementSnapshot {
  announcement: Announcement | null;
  /** When this answer arrived (epoch ms, the client clock). */
  receivedAt: number;
}

/** A request that has not answered (body included) by then is aborted, so a hang counts as a failure. */
export const FETCH_TIMEOUT_MS = 10_000;

/**
 * TanStack's cancellation signal combined with our own deadline. The deadline is a plain `setTimeout` +
 * AbortController rather than `AbortSignal.timeout`, so it behaves the same under fake timers in tests; the two
 * signals are joined with `AbortSignal.any` where it exists, else by forwarding the caller's abort.
 */
function withDeadline(signal?: AbortSignal): { signal: AbortSignal; done: () => void } {
  const deadline = new AbortController();
  const id = setTimeout(
    () => deadline.abort(new DOMException("announcement request timed out", "TimeoutError")),
    FETCH_TIMEOUT_MS,
  );
  if (!signal) return { signal: deadline.signal, done: () => clearTimeout(id) };
  const any = (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof any === "function") {
    return { signal: any.call(AbortSignal, [signal, deadline.signal]), done: () => clearTimeout(id) };
  }
  const forward = () => deadline.abort(signal.reason);
  if (signal.aborted) forward();
  else signal.addEventListener("abort", forward, { once: true });
  return {
    signal: deadline.signal,
    done: () => {
      clearTimeout(id);
      signal.removeEventListener("abort", forward);
    },
  };
}

export async function fetchAnnouncement(signal?: AbortSignal): Promise<AnnouncementSnapshot> {
  const request = withDeadline(signal);
  try {
    const res = await fetch(ANNOUNCEMENT_PATH, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: request.signal,
    });
    if (res.status !== 200) {
      throw new Error(`announcement: HTTP ${res.status}`);
    }
    const type = res.headers.get("content-type") ?? "";
    if (!/^application\/json\b/i.test(type)) {
      throw new Error("announcement: not JSON");
    }
    const announcement = parseAnnouncementBody(await res.json());
    return { announcement, receivedAt: Date.now() };
  } finally {
    request.done();
  }
}

/** The shell header's height: the app header row plus the strip while it shows. */
export function shellHeaderHeight(bannerVisible: boolean): number {
  return HEADER_HEIGHT + (bannerVisible ? BANNER_HEIGHT : 0);
}

/**
 * `now` as state: re-read at the next boundary of what the banner shows (capped steps) and whenever the tab becomes
 * visible again (a timer may have been throttled or the machine asleep).
 *
 * A hidden tab is never re-evaluated: a boundary timer that fires while hidden leaves `now` alone, and the
 * `visibilitychange` back to visible re-reads it one task later, after TanStack's own focus listener has started the
 * refetch. So a tab hidden past the 5-minute freshness limit keeps its strip on return while that refetch is in
 * flight (see `fetching` below) instead of hiding it and showing it again a moment later.
 */
function useBoundaryClock(announcement: Announcement | null, receivedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  const boundary = nextBoundary(announcement, receivedAt, now);

  useEffect(() => {
    let deferred: ReturnType<typeof setTimeout> | undefined;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") return;
      clearTimeout(deferred);
      deferred = setTimeout(() => setNow(Date.now()), 0);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearTimeout(deferred);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  useEffect(() => {
    if (boundary === null) return;
    // +1 ms: when the timer fires, the clock is past the boundary, so `now` changes and the next one is armed.
    const delay = Math.min(Math.max(boundary - Date.now(), 0) + 1, MAX_TIMER_MS);
    const id = setTimeout(() => {
      if (document.visibilityState !== "hidden") setNow(Date.now());
    }, delay);
    return () => clearTimeout(id);
  }, [boundary, now]);

  return now;
}

export interface AnnouncementState {
  /** Whether the strip shows (in its window, fresh, and not dismissed). */
  visible: boolean;
  announcement: Announcement | null;
  phase: AnnouncementPhase | null;
  dismissible: boolean;
  /** The clock the state was computed at (epoch ms). */
  now: number;
  dismiss: () => void;
}

export function useAnnouncement(): AnnouncementState {
  const { data } = useQuery({
    queryKey: ANNOUNCEMENT_QUERY_KEY,
    queryFn: ({ signal }) => fetchAnnouncement(signal),
    enabled: !isNativeAuthEnabled(),
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  const announcement = data?.announcement ?? null;
  const receivedAt = data?.receivedAt ?? null;

  const now = useBoundaryClock(announcement, receivedAt);
  // Live, not the observer's `isFetching`: `useIsFetching` reads the cache when it renders, so a refetch that has
  // just started counts even before TanStack's batched observer notification arrives.
  const fetching = useIsFetching({ queryKey: ANNOUNCEMENT_QUERY_KEY }) > 0;

  const [dismissedVersion, setDismissedVersion] = useState<number | null>(() =>
    readDismissedVersion(),
  );

  // While a refetch is in flight the last answer still counts: its outcome decides. A failed one ends `fetching`, so a
  // stale answer then hides (the fail-safe holds); a good one renews `receivedAt`.
  const fresh = receivedAt !== null && (isFresh(receivedAt, now) || fetching);
  const phase = announcement && fresh ? phaseOf(announcement, now) : null;
  const dismissible = announcement !== null && phase !== null && isDismissible(announcement, now);
  // A dismissal applies only while the announcement is still dismissible: one made while "upcoming" stops
  // applying when the downtime starts, and the banner returns (not dismissible).
  const dismissed =
    announcement !== null && dismissible && dismissedVersion === announcement.version;

  const version = announcement?.version ?? null;
  const dismiss = useCallback(() => {
    if (version === null) return;
    storeDismissedVersion(version);
    setDismissedVersion(version);
  }, [version]);

  return {
    visible: phase !== null && !dismissed,
    announcement,
    phase,
    dismissible,
    now,
    dismiss,
  };
}
