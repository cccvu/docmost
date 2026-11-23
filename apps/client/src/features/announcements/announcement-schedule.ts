// wiki-v2 #939 — NOT upstream Docmost code. When the announcement banner shows, and in which phase. Pure functions
// of the announcement and a `now` the caller passes in (never read here), so every rule has a truth table.
//
//   effective end = endsAt ?? downtimeEndsAt   (the platform refuses endsAt together with a downtime)
//   hidden        = now < startsAt  or  now >= effective end
//   phase         = "notice" (no downtime) | "upcoming" (now < downtimeStartsAt) | "in_progress" (during it)
//   dismissible   = severity !== "critical" and phase !== "in_progress"
//
// Freshness is the fail-safe: a response is trusted for MAX_STALE_MS after it arrived. When the platform stops
// answering (a failed poll keeps the last good data), the banner hides once that runs out, so a cancelled
// announcement outlives its cancellation by at most this long.

import type { Announcement } from "./announcement-contract";

export type AnnouncementPhase = "notice" | "upcoming" | "in_progress";

/** How long a good response is trusted after it arrived (ms). */
export const MAX_STALE_MS = 5 * 60_000;

/** The instant the banner hides for good, or null when it has no end. */
export function effectiveEnd(a: Announcement): number | null {
  return a.endsAt ?? a.downtimeEndsAt;
}

/** The phase at `now`, or null when the banner is outside its window. */
export function phaseOf(a: Announcement, now: number): AnnouncementPhase | null {
  if (a.startsAt !== null && now < a.startsAt) return null;
  const end = effectiveEnd(a);
  if (end !== null && now >= end) return null;
  if (a.downtimeStartsAt === null || a.downtimeEndsAt === null) return "notice";
  return now < a.downtimeStartsAt ? "upcoming" : "in_progress";
}

export function isVisible(a: Announcement | null | undefined, now: number): boolean {
  return a != null && phaseOf(a, now) !== null;
}

/** Whether a reader may hide it. A dismissal never covers a critical notice or a downtime in progress. */
export function isDismissible(a: Announcement, now: number): boolean {
  const phase = phaseOf(a, now);
  return phase !== null && a.severity !== "critical" && phase !== "in_progress";
}

/** Whether a response received at `receivedAt` may still be shown at `now`. */
export function isFresh(receivedAt: number, now: number): boolean {
  return now - receivedAt < MAX_STALE_MS;
}

/**
 * The next instant strictly after `now` at which what the banner shows can change: its start, the downtime start,
 * its end, or the moment the response goes stale. Null when there is none.
 */
export function nextBoundary(
  a: Announcement | null | undefined,
  receivedAt: number | null,
  now: number,
): number | null {
  const candidates: Array<number | null> = [
    receivedAt === null ? null : receivedAt + MAX_STALE_MS,
  ];
  if (a) {
    candidates.push(a.startsAt, a.downtimeStartsAt, effectiveEnd(a));
  }
  let next: number | null = null;
  for (const c of candidates) {
    if (c !== null && c > now && (next === null || c < next)) next = c;
  }
  return next;
}
