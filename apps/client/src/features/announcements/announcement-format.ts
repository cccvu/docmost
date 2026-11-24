// wiki-v2 #939 — NOT upstream Docmost code. How the banner writes its times.
//
// Times read in US Central, like every absolute time in the wiki (features/editor-ux/format-central-datetime.ts),
// each with its OWN zone abbreviation. The start and the end are formatted separately, never with
// `Intl.DateTimeFormat#formatRange`: that prints one shared abbreviation for both ends, so a window across a DST
// change reads an hour short or long ("1:00 – 3:00 AM CST" for 1:00 AM CDT to 3:00 AM CST). The end drops its date
// when it falls on the same Central day as the start.
//
// A viewer whose UTC offset differs from Central's at that instant also gets their own time ("3:00 PM" here, which
// the banner shows as "(3:00 PM your time)"), with the date when their calendar day differs from Central's. The
// viewer zone is injectable for tests; it defaults to the browser's resolved zone.
//
// Durations come from the UTC milliseconds, never from the formatted wall-clock strings.

import { formatCentralDateTime } from "@/features/editor-ux/format-central-datetime";

export const CENTRAL_ZONE = "America/Chicago";

const centralTime = new Intl.DateTimeFormat("en-US", {
  timeZone: CENTRAL_ZONE,
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZoneName: "short",
});

// The strip's narrow-screen form (#946): the date without its year. The full form is in Details and is what a
// screen reader hears on the strip.
const centralShortDateTime = new Intl.DateTimeFormat("en-US", {
  timeZone: CENTRAL_ZONE,
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZoneName: "short",
});

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(key: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  let f = formatterCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", options);
    formatterCache.set(key, f);
  }
  return f;
}

function wallClock(zone: string, ms: number): Record<string, number> {
  const parts = formatter(`wall:${zone}`, {
    timeZone: zone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  }).formatToParts(ms);
  const out: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return out;
}

/** The zone's UTC offset at that instant, in minutes (Central in summer: -300). */
export function utcOffsetMinutes(zone: string, ms: number): number {
  const w = wallClock(zone, ms);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour % 24, w.minute, w.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

function dayKey(zone: string, ms: number): string {
  const w = wallClock(zone, ms);
  return `${w.year}-${w.month}-${w.day}`;
}

/** The browser's IANA zone, or undefined when it cannot be read. */
export function defaultViewerZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

export interface FormattedInstant {
  /** "Nov 1, 2026, 1:00 AM CDT", or "3:00 AM CST" when the date is dropped. */
  central: string;
  /** The same without the year: "Nov 1, 1:00 AM CDT", or "3:00 AM CST" when the date is dropped. */
  centralShort: string;
  /** The viewer's own time when their offset differs from Central's at that instant, else null. */
  viewer: string | null;
}

export interface FormatOptions {
  /** Include the Central date (default true). */
  withDate?: boolean;
  /** The viewer's IANA zone (default: the browser's). */
  viewerZone?: string;
}

function viewerTime(ms: number, zone: string | undefined): string | null {
  if (!zone) return null;
  try {
    if (utcOffsetMinutes(zone, ms) === utcOffsetMinutes(CENTRAL_ZONE, ms)) return null;
    const sameDay = dayKey(zone, ms) === dayKey(CENTRAL_ZONE, ms);
    const f = sameDay
      ? formatter(`time:${zone}`, { timeZone: zone, hour: "numeric", minute: "2-digit", hour12: true })
      : formatter(`date:${zone}`, {
          timeZone: zone,
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });
    return f.format(ms);
  } catch {
    // An unknown zone name: show Central only.
    return null;
  }
}

export function formatInstant(
  ms: number,
  { withDate = true, viewerZone = defaultViewerZone() }: FormatOptions = {},
): FormattedInstant {
  return {
    central: withDate ? formatCentralDateTime(ms) : centralTime.format(ms),
    centralShort: withDate ? centralShortDateTime.format(ms) : centralTime.format(ms),
    viewer: viewerTime(ms, viewerZone),
  };
}

export interface FormattedWindow {
  start: FormattedInstant;
  end: FormattedInstant;
  durationMs: number;
}

/** A start–end window: each end with its own abbreviation; the end's date dropped on the same Central day. */
export function formatWindow(
  startMs: number,
  endMs: number,
  { viewerZone = defaultViewerZone() }: Pick<FormatOptions, "viewerZone"> = {},
): FormattedWindow {
  const sameDay = dayKey(CENTRAL_ZONE, startMs) === dayKey(CENTRAL_ZONE, endMs);
  return {
    start: formatInstant(startMs, { viewerZone }),
    end: formatInstant(endMs, { withDate: !sameDay, viewerZone }),
    durationMs: endMs - startMs,
  };
}

/** Whole hours and the remaining minutes of a duration, rounded to the nearest minute. */
export function durationParts(ms: number): { hours: number; minutes: number } {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
}
