import { describe, it, expect } from "vitest";
import { AnnouncementShapeError, parseAnnouncementBody } from "./announcement-contract";
import vectors from "./announcement-public-vectors.json";

// wiki-v2 #939 — the public GET /bff/announcement body. NOT upstream Docmost code.
//
// #946: announcement-public-vectors.json is byte-identical to the platform's
// services/platform/test/fixtures/announcement-public-vectors.json. The platform's announcement.http.spec.ts proves each
// `body` is exactly what GET /bff/announcement answers (and that the two copies match); here the real parser must turn
// each `body` into its `parsed` (times as epoch ms).

const good = {
  version: 3,
  message: "Planned maintenance",
  severity: "warning",
  startsAt: "2026-12-01T00:00:00.000Z",
  endsAt: null,
  downtimeStartsAt: "2026-12-03T06:00:00.000Z",
  downtimeEndsAt: "2026-12-03T09:00:00.000Z",
};

describe("parseAnnouncementBody", () => {
  it("has golden vectors to check (anti-vacuity): a null and at least one announcement", () => {
    expect(vectors.some((v) => v.parsed === null)).toBe(true);
    expect(
      vectors.filter((v) => v.parsed !== null).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it.each(vectors.map((v) => [v.name, v] as const))(
    "golden vector: %s",
    (_n, v) => {
      expect(parseAnnouncementBody(v.body)).toEqual(v.parsed);
    },
  );

  it("parses null", () => {
    expect(parseAnnouncementBody({ announcement: null })).toBeNull();
  });

  it("parses an announcement, times to epoch ms", () => {
    expect(parseAnnouncementBody({ announcement: good })).toEqual({
      version: 3,
      message: "Planned maintenance",
      severity: "warning",
      startsAt: Date.parse("2026-12-01T00:00:00Z"),
      endsAt: null,
      downtimeStartsAt: Date.parse("2026-12-03T06:00:00Z"),
      downtimeEndsAt: Date.parse("2026-12-03T09:00:00Z"),
    });
  });

  it.each([
    ["not an object", "<!doctype html>"],
    ["no announcement key", {}],
    ["an array", { announcement: [] }],
    ["version 0", { announcement: { ...good, version: 0 } }],
    ["version not an integer", { announcement: { ...good, version: 1.5 } }],
    ["version a string", { announcement: { ...good, version: "3" } }],
    ["empty message", { announcement: { ...good, message: "" } }],
    ["unknown severity", { announcement: { ...good, severity: "emergency" } }],
    ["unparseable time", { announcement: { ...good, startsAt: "soon" } }],
    ["time as a number", { announcement: { ...good, startsAt: 1 } }],
    ["half a downtime", { announcement: { ...good, downtimeEndsAt: null } }],
    ["missing time field (undefined)", { announcement: { ...good, endsAt: undefined } }],
  ])("refuses %s", (_n, body) => {
    expect(() => parseAnnouncementBody(body)).toThrow(AnnouncementShapeError);
  });
});
