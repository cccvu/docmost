import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * wiki-v2 #939: at 320 px (a phone, or 400% zoom) the strip's fixed parts (icon, "Scheduled maintenance", Details,
 * Dismiss) were wider than the screen. The message shrank to nothing and the strip's `overflow: hidden` then clipped
 * the Dismiss button. The texts must be the only things that shrink. jsdom applies no stylesheet, so this reads the
 * CSS as text; the browser proof is e2e/tests/wiki/announcement.spec.ts (B-44, 320 px).
 */
const css = readFileSync(resolve(__dirname, "announcement-banner.module.css"), "utf8");

/** The declarations of every flat `selector { body }` rule for `selector` (media blocks included), in order. */
function declarations(selector: string): Record<string, string> {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
  const out: Record<string, string> = {};
  for (const m of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].trim() !== selector) continue;
    for (const d of m[2].split(";")) {
      const [p, ...v] = d.split(":");
      if (p.trim()) out[p.trim()] = v.join(":").trim();
    }
  }
  return out;
}

describe("announcement strip layout CSS", () => {
  it("never shrinks the icon or the actions", () => {
    expect(declarations(".icon")["flex-shrink"]).toBe("0");
    expect(declarations(".actions")["flex-shrink"]).toBe("0");
  });

  it("lets the label shrink with an ellipsis instead of pushing the actions out", () => {
    const label = declarations(".label");
    expect(label.flex).toBe("0 1 auto");
    expect(label["min-width"]).toBe("0");
    expect(label.overflow).toBe("hidden");
    expect(label["text-overflow"]).toBe("ellipsis");
  });

  it("gives the message only the room left over (a zero basis)", () => {
    const message = declarations(".message");
    expect(message.flex).toBe("1 1 0");
    expect(message["min-width"]).toBe("0");
  });
});
