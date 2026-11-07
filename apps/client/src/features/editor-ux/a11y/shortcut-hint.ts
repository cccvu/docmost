import { platformModifierLabel } from "@/lib/utils";

export interface ShortcutHint {
  /** Visible tooltip text, e.g. "Bold · ⌘B" / "Strikethrough · Ctrl⇧S". */
  tooltip: string;
  /** `aria-keyshortcuts` value, e.g. "Meta+B" / "Control+Shift+S". */
  ariaKeyshortcuts: string;
}

/**
 * Tooltip + aria-keyshortcuts for a Mod(+Shift)+key toolbar shortcut (issue
 * #135), so users can learn the shortcut and assistive tech can announce it.
 * `modLabel` is "⌘" on Apple and "Ctrl" elsewhere; injectable for tests.
 */
export function shortcutHint(
  label: string,
  key: string,
  opts: { shift?: boolean } = {},
  modLabel: string = platformModifierLabel,
): ShortcutHint {
  const ariaMod = modLabel === "⌘" ? "Meta" : "Control";
  return {
    tooltip: `${label} · ${modLabel}${opts.shift ? "⇧" : ""}${key}`,
    ariaKeyshortcuts: [ariaMod, opts.shift && "Shift", key]
      .filter(Boolean)
      .join("+"),
  };
}
