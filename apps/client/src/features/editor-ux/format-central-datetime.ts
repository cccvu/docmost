// CCC (fork-owned): absolute-timestamp formatter pinned to US Central Time.
//
// The wiki serves a single institution in the Central timezone, so page
// timestamps (e.g. the "Updated by … · <when>" byline) should read the same
// for every viewer regardless of their browser locale/zone. Native
// `Intl.DateTimeFormat` with an IANA `timeZone` is the client's established
// absolute-date idiom (see features/notification, features/label) and, with
// `timeZoneName: "short"`, emits the DST-aware abbreviation automatically
// ("CDT" in summer, "CST" in winter) — no date library or DST bookkeeping.
//
// The upstream helpers in `lib/time.ts` render in the browser-local zone with
// no timezone label, so they cannot express this; this lives in a fork-owned
// module to keep those upstream files pristine.

// A single reusable formatter instance — constructing `Intl.DateTimeFormat`
// is comparatively expensive, so build it once at module load.
const centralDateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZoneName: "short",
});

/**
 * Format an instant as an absolute Central-Time string, e.g.
 * "Sep 17, 2026, 3:48 PM CDT" (automatically "CST" outside daylight saving).
 *
 * @param date A `Date`, ISO string, or epoch millis.
 * @returns The formatted string, or "" when the input is missing/invalid.
 */
export function formatCentralDateTime(
  date: Date | string | number | null | undefined,
): string {
  if (date == null) return "";
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  return centralDateTimeFormatter.format(d);
}
