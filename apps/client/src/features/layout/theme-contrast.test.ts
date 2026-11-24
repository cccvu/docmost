// wiki-v2 #913: Mantine's dark resolver maps the error colour to red.8 #a82022, 1.91–2.44:1 on the dark input fills
// and body, so error borders (1.4.11, 3:1), error text and typed text in an error input (1.4.3, 4.5:1) all fail in
// dark. The theme maps it to red.3; this pins the mapping and recomputes the ratios from the theme's own tuples.
import { describe, expect, it } from "vitest";
import { DEFAULT_THEME, mergeMantineTheme } from "@mantine/core";
import { mantineCssResolver, theme } from "@/theme";

const merged = mergeMantineTheme(DEFAULT_THEME, theme);
const resolved = mantineCssResolver(merged);

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `var(--mantine-color-<name>-<shade>)` → the theme's hex for it. */
function hexOf(value: string): string {
  const m = /^var\(--mantine-color-([a-zA-Z]+)-(\d)\)$/.exec(value);
  expect(m, `not a palette reference: ${value}`).not.toBeNull();
  return merged.colors[m![1]][Number(m![2])];
}

describe("theme: error colour contrast (#913)", () => {
  it("maps the dark error colour to red.3 and keeps light at red.7", () => {
    expect(resolved.dark["--mantine-color-error"]).toBe(
      "var(--mantine-color-red-3)",
    );
    expect(resolved.light["--mantine-color-error"]).toBe(
      "var(--mantine-color-red-7)",
    );
  });

  it.each([
    [5, "the filled input"],
    [6, "the default input"],
    [7, "the body"],
  ])("the dark error colour clears 4.5:1 on dark.%i (%s)", (shade) => {
    const error = hexOf(resolved.dark["--mantine-color-error"]);
    expect(contrast(error, merged.colors.dark[shade])).toBeGreaterThanOrEqual(
      4.5,
    );
  });
});
