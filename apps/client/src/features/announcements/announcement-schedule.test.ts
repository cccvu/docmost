import { describe, it, expect } from "vitest";
import type { Announcement } from "./announcement-contract";
import {
  MAX_STALE_MS,
  effectiveEnd,
  isDismissible,
  isFresh,
  isVisible,
  nextBoundary,
  phaseOf,
} from "./announcement-schedule";

// wiki-v2 #939 — truth tables for the banner's schedule rules. NOT upstream Docmost code.

const T = (s: string) => Date.parse(s);

function make(over: Partial<Announcement> = {}): Announcement {
  return {
    version: 1,
    message: "m",
    severity: "info",
    startsAt: null,
    endsAt: null,
    downtimeStartsAt: null,
    downtimeEndsAt: null,
    ...over,
  };
}

const notice = make({ startsAt: T("2026-12-01T00:00:00Z"), endsAt: T("2026-12-02T00:00:00Z") });
const maint = make({
  startsAt: T("2026-12-01T00:00:00Z"),
  downtimeStartsAt: T("2026-12-03T06:00:00Z"),
  downtimeEndsAt: T("2026-12-03T09:00:00Z"),
});

describe("effectiveEnd", () => {
  it.each([
    ["endsAt", notice, T("2026-12-02T00:00:00Z")],
    ["downtimeEndsAt when no endsAt", maint, T("2026-12-03T09:00:00Z")],
    ["null when neither", make(), null],
  ])("%s", (_n, a, want) => {
    expect(effectiveEnd(a)).toBe(want);
  });
});

describe("phaseOf", () => {
  it.each([
    ["before startsAt → hidden", notice, "2026-11-30T23:59:59.999Z", null],
    ["at startsAt → notice", notice, "2026-12-01T00:00:00Z", "notice"],
    ["inside → notice", notice, "2026-12-01T12:00:00Z", "notice"],
    ["1 ms before endsAt → notice", notice, "2026-12-01T23:59:59.999Z", "notice"],
    ["at endsAt → hidden", notice, "2026-12-02T00:00:00Z", null],
    ["after endsAt → hidden", notice, "2026-12-05T00:00:00Z", null],
    ["no window at all → notice", make(), "2030-01-01T00:00:00Z", "notice"],
    ["before startsAt (maintenance) → hidden", maint, "2026-11-30T00:00:00Z", null],
    ["before downtime → upcoming", maint, "2026-12-02T00:00:00Z", "upcoming"],
    ["1 ms before downtime → upcoming", maint, "2026-12-03T05:59:59.999Z", "upcoming"],
    ["at downtime start → in_progress", maint, "2026-12-03T06:00:00Z", "in_progress"],
    ["during downtime → in_progress", maint, "2026-12-03T08:59:59.999Z", "in_progress"],
    ["at downtime end → hidden", maint, "2026-12-03T09:00:00Z", null],
  ])("%s", (_n, a, at, want) => {
    expect(phaseOf(a, T(at))).toBe(want);
  });
});

describe("isVisible", () => {
  it.each([
    ["null announcement", null, "2026-12-01T12:00:00Z", false],
    ["undefined announcement", undefined, "2026-12-01T12:00:00Z", false],
    ["inside window", notice, "2026-12-01T12:00:00Z", true],
    ["before window", notice, "2026-11-30T12:00:00Z", false],
    ["after window", notice, "2026-12-02T12:00:00Z", false],
  ])("%s", (_n, a, at, want) => {
    expect(isVisible(a, T(at))).toBe(want);
  });
});

describe("isDismissible", () => {
  const during = "2026-12-03T07:00:00Z";
  const before = "2026-12-02T00:00:00Z";
  it.each([
    ["info notice", make({ severity: "info" }), before, true],
    ["warning notice", make({ severity: "warning" }), before, true],
    ["critical notice", make({ severity: "critical" }), before, false],
    ["info upcoming", maint, before, true],
    ["warning upcoming", { ...maint, severity: "warning" as const }, before, true],
    ["critical upcoming", { ...maint, severity: "critical" as const }, before, false],
    ["info in progress", maint, during, false],
    ["warning in progress", { ...maint, severity: "warning" as const }, during, false],
    ["hidden (ended)", maint, "2026-12-04T00:00:00Z", false],
  ])("%s", (_n, a, at, want) => {
    expect(isDismissible(a, T(at))).toBe(want);
  });
});

describe("isFresh", () => {
  const r = T("2026-12-01T00:00:00Z");
  it.each([
    ["just received", r, true],
    ["clock behind receipt", r - 1000, true],
    ["1 ms before the limit", r + MAX_STALE_MS - 1, true],
    ["at the limit", r + MAX_STALE_MS, false],
    ["well past", r + 60 * 60_000, false],
  ])("%s", (_n, now, want) => {
    expect(isFresh(r, now)).toBe(want);
  });

  it("trusts an answer for five minutes", () => {
    expect(MAX_STALE_MS).toBe(5 * 60_000);
  });
});

describe("nextBoundary", () => {
  const r = T("2026-12-02T00:00:00Z");
  it.each([
    ["nothing at all", null, null, r, null],
    ["staleness only (no announcement)", null, r, r, r + MAX_STALE_MS],
    ["start before staleness", notice, r, T("2026-11-30T23:58:00Z"), T("2026-12-01T00:00:00Z")],
    ["staleness before the end", notice, T("2026-12-01T23:00:00Z"), T("2026-12-01T23:00:00Z"), T("2026-12-01T23:05:00Z")],
    ["end before staleness", notice, T("2026-12-01T23:58:00Z"), T("2026-12-01T23:58:00Z"), T("2026-12-02T00:00:00Z")],
    ["downtime start", maint, T("2026-12-03T05:58:00Z"), T("2026-12-03T05:58:00Z"), T("2026-12-03T06:00:00Z")],
    ["downtime end (start passed)", maint, T("2026-12-03T08:58:00Z"), T("2026-12-03T08:58:00Z"), T("2026-12-03T09:00:00Z")],
    ["strictly after now (a boundary AT now is skipped)", maint, null, T("2026-12-03T06:00:00Z"), T("2026-12-03T09:00:00Z")],
    ["all passed", maint, null, T("2026-12-04T00:00:00Z"), null],
  ])("%s", (_n, a, receivedAt, now, want) => {
    expect(nextBoundary(a, receivedAt, now)).toBe(want);
  });
});
