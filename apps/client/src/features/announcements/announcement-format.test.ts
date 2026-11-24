import { describe, it, expect } from "vitest";
import {
  CENTRAL_ZONE,
  durationParts,
  formatInstant,
  formatWindow,
  utcOffsetMinutes,
} from "./announcement-format";

// wiki-v2 #939 — how the banner writes times. NOT upstream Docmost code.
//
// ICU versions differ in the space before AM/PM (U+0020, U+202F narrow no-break, U+2009 thin) and may use U+00A0;
// normalise all of them so the assertions pin the text, not the ICU build.
const norm = (s: string | null) => (s === null ? null : s.replace(/[\u2009\u202f\u00a0]/g, " "));
const T = (s: string) => Date.parse(s);

describe("utcOffsetMinutes", () => {
  it.each([
    [CENTRAL_ZONE, "2026-07-01T12:00:00Z", -300],
    [CENTRAL_ZONE, "2026-01-15T12:00:00Z", -360],
    // the fall-back instant: 06:00Z is 1:00 AM CDT, 07:00Z is 1:00 AM CST
    [CENTRAL_ZONE, "2026-11-01T06:59:59Z", -300],
    [CENTRAL_ZONE, "2026-11-01T07:00:00Z", -360],
    ["UTC", "2026-07-01T12:00:00Z", 0],
    ["Asia/Tokyo", "2026-07-01T12:00:00Z", 540],
    ["Asia/Kolkata", "2026-07-01T12:00:00Z", 330],
  ])("%s at %s", (zone, at, want) => {
    expect(utcOffsetMinutes(zone, T(at))).toBe(want);
  });
});

describe("formatWindow — Central, each end with its own abbreviation", () => {
  it("fall-back DST change (2026-11-01): 1:00 AM CDT to 3:00 AM CST is three hours", () => {
    const w = formatWindow(T("2026-11-01T06:00:00Z"), T("2026-11-01T09:00:00Z"), {
      viewerZone: CENTRAL_ZONE,
    });
    expect(norm(w.start.central)).toBe("Nov 1, 2026, 1:00 AM CDT");
    // same Central day: the end drops its date, keeps its own (different) abbreviation
    expect(norm(w.end.central)).toBe("3:00 AM CST");
    expect(durationParts(w.durationMs)).toEqual({ hours: 3, minutes: 0 });
    expect(w.start.viewer).toBeNull();
    expect(w.end.viewer).toBeNull();
  });

  it("fall-back: the repeated 1 AM hour reads CDT then CST", () => {
    const w = formatWindow(T("2026-11-01T05:30:00Z"), T("2026-11-01T07:30:00Z"), {
      viewerZone: CENTRAL_ZONE,
    });
    expect(norm(w.start.central)).toBe("Nov 1, 2026, 12:30 AM CDT");
    expect(norm(w.end.central)).toBe("1:30 AM CST");
    expect(durationParts(w.durationMs)).toEqual({ hours: 2, minutes: 0 });
  });

  it("spring-forward DST change (2026-03-08): 1:30 AM CST to 4:00 AM CDT is an hour and a half", () => {
    const w = formatWindow(T("2026-03-08T07:30:00Z"), T("2026-03-08T09:00:00Z"), {
      viewerZone: CENTRAL_ZONE,
    });
    expect(norm(w.start.central)).toBe("Mar 8, 2026, 1:30 AM CST");
    expect(norm(w.end.central)).toBe("4:00 AM CDT");
    expect(durationParts(w.durationMs)).toEqual({ hours: 1, minutes: 30 });
  });

  it("a range crossing Central midnight keeps the end's date", () => {
    const w = formatWindow(T("2026-11-24T04:00:00Z"), T("2026-11-24T08:00:00Z"), {
      viewerZone: CENTRAL_ZONE,
    });
    expect(norm(w.start.central)).toBe("Nov 23, 2026, 10:00 PM CST");
    expect(norm(w.end.central)).toBe("Nov 24, 2026, 2:00 AM CST");
    expect(durationParts(w.durationMs)).toEqual({ hours: 4, minutes: 0 });
  });
});

describe("formatInstant — the viewer's own time", () => {
  it("a Central viewer gets no extra time", () => {
    expect(formatInstant(T("2026-11-01T06:00:00Z"), { viewerZone: CENTRAL_ZONE }).viewer).toBeNull();
  });

  it("a UTC viewer gets their time (same calendar day: time only)", () => {
    const f = formatInstant(T("2026-11-01T06:00:00Z"), { viewerZone: "UTC" });
    expect(norm(f.central)).toBe("Nov 1, 2026, 1:00 AM CDT");
    expect(norm(f.viewer)).toBe("6:00 AM");
  });

  it("a Tokyo viewer gets their time", () => {
    const f = formatInstant(T("2026-11-01T06:00:00Z"), { viewerZone: "Asia/Tokyo" });
    expect(norm(f.viewer)).toBe("3:00 PM");
  });

  it("a Tokyo viewer on a different calendar day gets the date too", () => {
    const w = formatWindow(T("2026-11-24T04:00:00Z"), T("2026-11-24T08:00:00Z"), {
      viewerZone: "Asia/Tokyo",
    });
    expect(norm(w.start.viewer)).toBe("Nov 24, 1:00 PM");
    expect(norm(w.end.viewer)).toBe("5:00 PM");
  });

  it("compares offsets AT the instant: a fixed UTC-6 zone matches Central in winter, not in summer", () => {
    // America/Mexico_City has no DST (since 2022): UTC-6 all year.
    expect(formatInstant(T("2026-11-01T06:00:00Z"), { viewerZone: "America/Mexico_City" }).viewer).not.toBeNull();
    expect(formatInstant(T("2026-11-01T09:00:00Z"), { viewerZone: "America/Mexico_City" }).viewer).toBeNull();
  });

  it("an unknown zone shows Central only", () => {
    expect(formatInstant(T("2026-11-01T06:00:00Z"), { viewerZone: "Not/AZone" }).viewer).toBeNull();
  });

  it("withDate: false gives the time with its abbreviation", () => {
    expect(norm(formatInstant(T("2026-07-01T20:15:00Z"), { withDate: false, viewerZone: CENTRAL_ZONE }).central)).toBe(
      "3:15 PM CDT",
    );
  });
});

describe("centralShort — the strip's narrow-screen form (#946)", () => {
  it("drops the year and keeps the date, the time and the abbreviation", () => {
    const f = formatInstant(T("2026-12-01T06:00:00Z"), { viewerZone: CENTRAL_ZONE });
    expect(norm(f.central)).toBe("Dec 1, 2026, 12:00 AM CST");
    expect(norm(f.centralShort)).toBe("Dec 1, 12:00 AM CST");
  });

  it("reads Central, with each end's own abbreviation, on the fall-back day", () => {
    const w = formatWindow(T("2026-11-01T06:00:00Z"), T("2026-11-01T09:00:00Z"), { viewerZone: "UTC" });
    expect(norm(w.start.centralShort)).toBe("Nov 1, 1:00 AM CDT");
    // same Central day: the end is the time alone, in both forms
    expect(norm(w.end.centralShort)).toBe("3:00 AM CST");
  });

  it("keeps the end's date when the window crosses Central midnight", () => {
    const w = formatWindow(T("2026-11-24T04:00:00Z"), T("2026-11-24T08:00:00Z"), { viewerZone: CENTRAL_ZONE });
    expect(norm(w.start.centralShort)).toBe("Nov 23, 10:00 PM CST");
    expect(norm(w.end.centralShort)).toBe("Nov 24, 2:00 AM CST");
  });
});

describe("durationParts", () => {
  it.each([
    [0, 0, 0],
    [29_999, 0, 0],
    [30_000, 0, 1],
    [45 * 60_000, 0, 45],
    [60 * 60_000, 1, 0],
    [90 * 60_000, 1, 30],
    [26 * 60 * 60_000, 26, 0],
    [-5, 0, 0],
  ])("%d ms → %dh %dm", (ms, hours, minutes) => {
    expect(durationParts(ms)).toEqual({ hours, minutes });
  });
});
