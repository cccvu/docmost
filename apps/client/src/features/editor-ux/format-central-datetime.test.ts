import { describe, it, expect } from "vitest";
import { formatCentralDateTime } from "./format-central-datetime";

describe("formatCentralDateTime", () => {
  it("renders a summer instant in CDT (UTC-5)", () => {
    // 2026-09-17T20:48:00Z → 15:48 America/Chicago (CDT).
    const out = formatCentralDateTime("2026-09-17T20:48:00Z");
    expect(out).toContain("Sep 17, 2026");
    expect(out).toContain("3:48 PM");
    expect(out).toContain("CDT");
  });

  it("renders a winter instant in CST (UTC-6)", () => {
    // 2026-01-15T21:48:00Z → 15:48 America/Chicago (CST).
    const out = formatCentralDateTime("2026-01-15T21:48:00Z");
    expect(out).toContain("Jan 15, 2026");
    expect(out).toContain("3:48 PM");
    expect(out).toContain("CST");
  });

  it("pins the zone regardless of the input's own offset representation", () => {
    // Same instant expressed in a +02:00 offset → still Central.
    const out = formatCentralDateTime("2026-09-17T22:48:00+02:00");
    expect(out).toContain("3:48 PM");
    expect(out).toContain("CDT");
  });

  it("accepts a Date object", () => {
    const out = formatCentralDateTime(new Date("2026-09-17T20:48:00Z"));
    expect(out).toContain("3:48 PM CDT");
  });

  it("returns an empty string for missing or invalid input", () => {
    expect(formatCentralDateTime(null)).toBe("");
    expect(formatCentralDateTime(undefined)).toBe("");
    expect(formatCentralDateTime("not-a-date")).toBe("");
  });
});
