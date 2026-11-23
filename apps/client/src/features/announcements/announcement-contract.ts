// wiki-v2 #939 — NOT upstream Docmost code. The wire shape of the platform's public `GET /bff/announcement`.
//
// The platform answers `{ "announcement": null }` or `{ "announcement": { version, message, severity, startsAt,
// endsAt, downtimeStartsAt, downtimeEndsAt } }`, the times as ISO instants or null. It returns an announcement only
// while it is enabled and inside its window (decided on the database clock); the client still hides it at its own
// boundaries, so a long-open tab never shows an ended notice.
//
// The parser is strict: anything that is not that shape throws, and the query keeps the last good answer (bounded
// by MAX_STALE_MS in announcement-schedule.ts). Times are converted to epoch milliseconds once, here.

export type AnnouncementSeverity = "info" | "warning" | "critical";

const SEVERITIES: readonly AnnouncementSeverity[] = ["info", "warning", "critical"];

/** One announcement, times as epoch milliseconds (null = not set). */
export interface Announcement {
  version: number;
  message: string;
  severity: AnnouncementSeverity;
  startsAt: number | null;
  endsAt: number | null;
  downtimeStartsAt: number | null;
  downtimeEndsAt: number | null;
}

export class AnnouncementShapeError extends Error {
  constructor(what: string) {
    super(`Unexpected announcement response: ${what}`);
    this.name = "AnnouncementShapeError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function instant(v: unknown, field: string): number | null {
  if (v === null) return null;
  if (typeof v !== "string") throw new AnnouncementShapeError(field);
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) throw new AnnouncementShapeError(field);
  return ms;
}

/** Parse the response body. Throws AnnouncementShapeError on any other shape. */
export function parseAnnouncementBody(body: unknown): Announcement | null {
  if (!isRecord(body) || !("announcement" in body)) {
    throw new AnnouncementShapeError("body");
  }
  const a = body.announcement;
  if (a === null) return null;
  if (!isRecord(a)) throw new AnnouncementShapeError("announcement");
  if (typeof a.version !== "number" || !Number.isInteger(a.version) || a.version < 1) {
    throw new AnnouncementShapeError("version");
  }
  if (typeof a.message !== "string" || a.message.length === 0) {
    throw new AnnouncementShapeError("message");
  }
  if (!SEVERITIES.includes(a.severity as AnnouncementSeverity)) {
    throw new AnnouncementShapeError("severity");
  }
  const downtimeStartsAt = instant(a.downtimeStartsAt, "downtimeStartsAt");
  const downtimeEndsAt = instant(a.downtimeEndsAt, "downtimeEndsAt");
  if ((downtimeStartsAt === null) !== (downtimeEndsAt === null)) {
    throw new AnnouncementShapeError("downtime");
  }
  return {
    version: a.version,
    message: a.message,
    severity: a.severity as AnnouncementSeverity,
    startsAt: instant(a.startsAt, "startsAt"),
    endsAt: instant(a.endsAt, "endsAt"),
    downtimeStartsAt,
    downtimeEndsAt,
  };
}
