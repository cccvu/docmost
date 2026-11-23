import { describe, it, expect } from "vitest";
import { AnnouncementShapeError, parseAnnouncementBody } from "./announcement-contract";

// wiki-v2 #939 — the public GET /bff/announcement body. NOT upstream Docmost code.

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
