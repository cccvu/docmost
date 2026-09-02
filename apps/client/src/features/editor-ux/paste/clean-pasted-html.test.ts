import { describe, it, expect } from "vitest";
import { cleanPastedHtml } from "./clean-pasted-html";

describe("cleanPastedHtml", () => {
  it("preserves inline styles on ProseMirror's own clipboard slice", () => {
    const internal =
      '<p data-pm-slice="1 1 []"><span style="color: #E00000">red</span></p>';
    expect(cleanPastedHtml(internal)).toBe(internal);
  });

  it("strips inline styles from external (non-slice) HTML", () => {
    const external = '<p><span style="color: #E00000; font-size: 40px">x</span></p>';
    const out = cleanPastedHtml(external);
    expect(out).not.toContain("style=");
    expect(out).toContain("<span>x</span>");
  });

  it("leaves markup without inline styles unchanged", () => {
    const html = "<p><strong>bold</strong></p>";
    expect(cleanPastedHtml(html)).toBe(html);
  });

  it("handles empty / non-string input defensively", () => {
    expect(cleanPastedHtml("")).toBe("");
    // Defensive runtime guard for non-string callers.
    expect(cleanPastedHtml(undefined as unknown as string)).toBe(undefined);
  });
});
