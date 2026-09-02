import { describe, it, expect } from "vitest";
import {
  ALLOWED_FONT_SIZES,
  FONT_FAMILY_OPTIONS,
  FONT_SIZE_OPTIONS,
  classifyFontFamily,
  normalizeFontFamily,
  normalizeFontSize,
} from "@docmost/editor-ext";

describe("font-size allowlist", () => {
  it("exposes Small/Normal/Large/Extra large with Normal unset", () => {
    expect(FONT_SIZE_OPTIONS.map((o) => o.value)).toEqual([
      "14px",
      null,
      "18px",
      "20px",
    ]);
    expect(ALLOWED_FONT_SIZES).toEqual(["14px", "18px", "20px"]);
  });

  it("keeps exact allowed values", () => {
    expect(normalizeFontSize("14px")).toBe("14px");
    expect(normalizeFontSize("18px")).toBe("18px");
    expect(normalizeFontSize("20px")).toBe("20px");
  });

  it("snaps off-scale sizes to the nearest step (16px normal → null)", () => {
    expect(normalizeFontSize("13px")).toBe("14px");
    expect(normalizeFontSize("15px")).toBe("14px");
    expect(normalizeFontSize("16px")).toBeNull();
    expect(normalizeFontSize("17px")).toBeNull(); // tie 16/18 rounds down → normal
    expect(normalizeFontSize("19px")).toBe("18px"); // tie 18/20 rounds down
    expect(normalizeFontSize("100px")).toBe("20px"); // clamped, never exceeds H3
  });

  it("converts pt/em/rem before snapping", () => {
    expect(normalizeFontSize("1.125rem")).toBe("18px"); // 18px
    expect(normalizeFontSize("1em")).toBeNull(); // 16px → normal
    expect(normalizeFontSize("15pt")).toBe("20px"); // 20px
  });

  it("drops unparseable / empty values", () => {
    expect(normalizeFontSize("")).toBeNull();
    expect(normalizeFontSize(null)).toBeNull();
    expect(normalizeFontSize("huge")).toBeNull();
    expect(normalizeFontSize("0px")).toBeNull();
  });
});

describe("font-family allowlist", () => {
  it("exposes Default/Serif/Monospace with Default unset", () => {
    expect(FONT_FAMILY_OPTIONS.map((o) => o.value)).toEqual([
      null,
      "serif",
      "monospace",
    ]);
  });

  it("classifies incoming stacks to a keyword or null", () => {
    expect(classifyFontFamily("Georgia, 'Times New Roman', serif")).toBe(
      "serif",
    );
    expect(classifyFontFamily("Menlo, monospace")).toBe("monospace");
    expect(classifyFontFamily("Inter, sans-serif")).toBeNull();
    expect(classifyFontFamily("Comic Sans MS")).toBeNull();
  });

  it("normalizes stored keywords and arbitrary input", () => {
    expect(normalizeFontFamily("serif")).toBe("serif");
    expect(normalizeFontFamily("monospace")).toBe("monospace");
    expect(normalizeFontFamily("Arial")).toBeNull();
    expect(normalizeFontFamily(null)).toBeNull();
  });
});
