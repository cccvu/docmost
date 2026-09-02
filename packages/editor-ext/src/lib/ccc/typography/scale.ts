/**
 * CCC controlled typography allowlist (issue #135).
 *
 * Font size and family are stored as attributes on the existing `textStyle`
 * mark — never as a new mark type. Because API/MCP authors write the canonical
 * ProseMirror JSON directly, the set of accepted values is an ALLOWLIST, not
 * arbitrary CSS. Sizes map to the Mantine sm/md/lg/xl scale and never reach a
 * content heading size (H3 = 20px), so H1/H2/H3 remain the document structure.
 *
 * This module is the single source of truth for the allowlist and is consumed
 * by the client schema, the server schema, and the toolbar UI.
 */

export interface FontSizeOption {
  /** English-text i18n key (renders itself when untranslated). */
  label: string;
  /** The stored `fontSize` attr value, or null for "Normal" (no attribute). */
  value: string | null;
}

/** Small=14 · Normal=16 (unset) · Large=18 · Extra large=20 (Mantine sm/md/lg/xl). */
export const FONT_SIZE_OPTIONS: readonly FontSizeOption[] = [
  { label: "Small", value: "14px" },
  { label: "Normal", value: null },
  { label: "Large", value: "18px" },
  { label: "Extra large", value: "20px" },
] as const;

/** The non-default sizes that may appear in `style="font-size:…"`. */
export const ALLOWED_FONT_SIZES: readonly string[] = FONT_SIZE_OPTIONS.map(
  (o) => o.value,
).filter((v): v is string => v !== null);

// "Normal" (the null option) has no stored value but anchors the scale at 16px:
// an incoming size closest to 16 snaps to null (no attribute).
const NORMAL_PX = 16;
// Derived from the single-source options so a future scale edit can't drift:
// the allowed sizes plus the Normal anchor, as numbers for nearest-step snapping.
// Sorted ascending so the `reduce` below breaks ties toward the SMALLER step
// (17px → 16px/null, 19px → 18px), the documented and tested rounding rule.
const PX_BY_SIZE = [
  NORMAL_PX,
  ...ALLOWED_FONT_SIZES.map((v) => parseInt(v, 10)),
].sort((a, b) => a - b);

/** px value of one CSS length, or null if unparseable. Supports px/pt/em/rem. */
function toPx(raw: string): number | null {
  const m = raw
    .trim()
    .toLowerCase()
    .match(/^(-?\d*\.?\d+)\s*(px|pt|em|rem)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  switch (m[2]) {
    case "pt":
      return n * (96 / 72);
    case "em":
    case "rem":
      return n * 16;
    default:
      return n; // px or unitless
  }
}

/**
 * Snap any incoming size to the controlled scale: an exact allowed value is
 * kept; anything else is parsed to px and rounded to the nearest step (16px
 * "Normal" → null, i.e. no attribute); unparseable → null. The output is
 * ALWAYS an allowed value or null, so hostile or arbitrary CSS from an HTML
 * import or the JSON/MCP API cannot survive into the stored mark.
 */
export function normalizeFontSize(raw?: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (ALLOWED_FONT_SIZES.includes(trimmed)) return trimmed;
  const px = toPx(trimmed);
  if (px == null) return null;
  const nearest = PX_BY_SIZE.reduce((a, b) =>
    Math.abs(b - px) < Math.abs(a - px) ? b : a,
  );
  return nearest === NORMAL_PX ? null : `${nearest}px`;
}

export type FontFamilyKeyword = "serif" | "monospace";

export interface FontFamilyOption {
  label: string;
  /** null = Default (the app's Inter stack, unset). */
  value: FontFamilyKeyword | null;
}

export const FONT_FAMILY_OPTIONS: readonly FontFamilyOption[] = [
  { label: "Default", value: null },
  { label: "Serif", value: "serif" },
  { label: "Monospace", value: "monospace" },
] as const;

/**
 * Controlled CSS stacks each keyword renders to. Kept in sync with the app
 * theme (`apps/client/src/theme.ts`): Serif is a Georgia stack; Monospace
 * reuses the theme's JetBrainsMono stack.
 */
export const FONT_FAMILY_STACKS: Record<FontFamilyKeyword, string> = {
  serif: "Georgia, 'Times New Roman', Times, serif",
  monospace:
    "JetBrainsMono, ui-monospace, SFMono-Regular, Menlo, Monaco, 'Liberation Mono', monospace",
};

/** Classify an incoming font-family CSS value to a controlled keyword, or null. */
export function classifyFontFamily(
  raw?: string | null,
): FontFamilyKeyword | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (s.includes("mono")) return "monospace";
  // Strip `sans-serif` first so it doesn't match the `serif` test below.
  const withoutSans = s.replace(/sans-serif/g, "");
  if (/serif|georgia|times|garamond|cambria/.test(withoutSans)) {
    return "serif";
  }
  return null;
}

/** Normalize an incoming family value to a stored keyword, or null (Default). */
export function normalizeFontFamily(
  raw?: string | null,
): FontFamilyKeyword | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (s === "serif" || s === "monospace") return s;
  return classifyFontFamily(raw);
}
