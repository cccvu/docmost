import { describe, it, expect, afterEach, vi } from "vitest";
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

  it("returns an empty string for empty / non-string input", () => {
    expect(cleanPastedHtml("")).toBe("");
    // The signature accepts unknown and is honest about it: never returns a
    // non-string, whatever a caller passes at runtime.
    expect(cleanPastedHtml(undefined)).toBe("");
    expect(cleanPastedHtml(null)).toBe("");
    expect(cleanPastedHtml(42)).toBe("");
  });

  // #145: the old `/\s+style="[^"]*"/gi` regex missed Word's single-quoted
  // markup and unquoted attributes, and deleted literal ` style="…"` TEXT.
  it("strips single-quoted style attributes (Word clipboard markup)", () => {
    const word =
      "<p><span style='font-size:11.0pt;font-family:\"Calibri\",sans-serif'>x</span></p>";
    const out = cleanPastedHtml(word);
    expect(out).not.toMatch(/style/i);
    expect(out).toContain("<span>x</span>");
  });

  it("strips unquoted and mixed-case style attributes", () => {
    const out = cleanPastedHtml(
      '<p><span style=color:red>a</span><b STYLE="font-size:40px">b</b></p>',
    );
    expect(out).not.toMatch(/style/i);
    expect(out).toContain("<span>a</span>");
    expect(out).toContain("<b>b</b>");
  });

  it('keeps literal style="…" text in pasted code intact', () => {
    const code =
      '<pre><code>&lt;div style="color:red"&gt;hi&lt;/div&gt;</code></pre>';
    const out = cleanPastedHtml(code);
    const doc = new DOMParser().parseFromString(out, "text/html");
    expect(doc.body.textContent).toBe('<div style="color:red">hi</div>');
  });

  it("keeps another attribute whose value mentions style=", () => {
    const html = '<p><a href="#x" title="a style=&quot;b&quot; c">x</a></p>';
    const out = cleanPastedHtml(html);
    const a = new DOMParser()
      .parseFromString(out, "text/html")
      .querySelector("a");
    expect(a?.getAttribute("title")).toBe('a style="b" c');
    expect(a?.getAttribute("href")).toBe("#x");
  });

  it("keeps a bare table-row fragment for ProseMirror to wrap", () => {
    const out = cleanPastedHtml('<tr><td style="color:red">a</td></tr>');
    expect(out).toBe("<tr><td>a</td></tr>");
  });

  describe("inert parse", () => {
    afterEach(() => {
      delete (globalThis as { __cccPasteProbe?: unknown }).__cccPasteProbe;
    });

    it("does not execute handlers or scripts in the pasted markup", () => {
      const probe = vi.fn();
      (globalThis as { __cccPasteProbe?: unknown }).__cccPasteProbe = probe;
      const out = cleanPastedHtml(
        '<p style="color:red">t</p><img src="x" onerror="__cccPasteProbe()"><script>__cccPasteProbe()</script>',
      );
      expect(probe).not.toHaveBeenCalled();
      // Markup passes through (ProseMirror's schema parse decides what survives).
      expect(out).toContain("<img");
      expect(out).not.toMatch(/style/i);
    });
  });
});
