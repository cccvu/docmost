import { describe, it, expect } from "vitest";
import { shortcutHint } from "./shortcut-hint";

// modLabel is injected: the real default (platformModifierLabel) is fixed at
// module load from navigator.platform, so both platforms are tested explicitly.
describe("shortcutHint", () => {
  it.each([
    // label, key, shift, modLabel → tooltip, aria-keyshortcuts
    ["Bold", "B", false, "⌘", "Bold · ⌘B", "Meta+B"],
    ["Bold", "B", false, "Ctrl", "Bold · CtrlB", "Control+B"],
    ["Italic", "I", false, "⌘", "Italic · ⌘I", "Meta+I"],
    ["Underline", "U", false, "Ctrl", "Underline · CtrlU", "Control+U"],
    ["Strikethrough", "S", true, "⌘", "Strikethrough · ⌘⇧S", "Meta+Shift+S"],
    [
      "Strikethrough",
      "S",
      true,
      "Ctrl",
      "Strikethrough · Ctrl⇧S",
      "Control+Shift+S",
    ],
  ])(
    "%s %s shift=%s on %s",
    (label, key, shift, modLabel, tooltip, ariaKeyshortcuts) => {
      expect(shortcutHint(label, key, { shift }, modLabel)).toEqual({
        tooltip,
        ariaKeyshortcuts,
      });
    },
  );

  it("defaults to the platform modifier and no shift", () => {
    const hint = shortcutHint("Bold", "B");
    expect(["Bold · ⌘B", "Bold · CtrlB"]).toContain(hint.tooltip);
    expect(hint.ariaKeyshortcuts).toBe(
      hint.tooltip.includes("⌘") ? "Meta+B" : "Control+B",
    );
  });
});
