import {
  Badge,
  createTheme,
  CSSVariablesResolver,
  MantineColorsTuple,
  Tabs,
  Tooltip,
  v8CssVariablesResolver,
} from "@mantine/core";

/*
 * Vanderbilt / College of Connected Computing (CCC) brand theme (issue #30).
 *
 * Design intent: a restrained institutional look. Chrome is near-black on a cool
 * Zinc neutral; Vanderbilt gold is an ACCENT only (CTAs, focus halo, brand mark),
 * never everyday chrome. `primaryColor` is a near-black scale that inverts to
 * near-white in dark mode (via `primaryShade`), so primary buttons read like the
 * CCC sister app's default button in both schemes. Gold text always uses the
 * darkened, AA-safe `gold-ink` (never bright gold on light — it fails contrast).
 */

// Near-black primary (Vanderbilt Black). Shade 6 (the default filled shade) is
// the near-black used for light-mode primary buttons/active states; shade 1
// (near-white) is swapped in for dark mode via the resolver below, so the
// primary inverts (shadcn / CCC-sister-app pattern) WITHOUT changing the global
// primaryShade — which would corrupt every other color's filled shade.
const vandyBlack: MantineColorsTuple = [
  "#f6f6f7",
  "#ececee", // near-white — dark-scheme primary bg
  "#d6d6d9",
  "#b5b5bb",
  "#8d8d95",
  "#46464d",
  "#18181b", // Vanderbilt Black — light-scheme primary bg (default shade 6)
  "#101014",
  "#0c0c0f",
  "#060608",
];

// Vanderbilt gold — bright #F2CC0C at index 6 (the filled shade), amber darks for
// hover/active, `gold-ink` (#B08900 ≈ 5:1 on white) at index 8 for gold TEXT.
const gold: MantineColorsTuple = [
  "#fffdf2",
  "#fef9e1",
  "#fcf0bd",
  "#f9e38a",
  "#f6d64e",
  "#f3ce24",
  "#f2cc0c", // bright Vanderbilt gold — brand CTA fill
  "#d9b00a",
  "#b08900", // gold-ink — AA-safe gold text on light
  "#8a6d00",
];

// Cool neutral (Zinc, near-chroma-zero) for light-mode borders, fills, dimmed text.
const gray: MantineColorsTuple = [
  "#fafafa",
  "#f4f4f5",
  "#e4e4e7",
  "#d4d4d8",
  "#a1a1aa",
  "#71717a",
  "#52525b",
  "#3f3f46",
  "#27272a",
  "#18181b",
];

// Cool-neutral dark surfaces (Zinc). Mantine maps dark[7] → body bg,
// dark[6] → elevated/border, dark[4] → strong border.
const dark: MantineColorsTuple = [
  "#f4f4f5",
  "#e4e4e7",
  "#c9c9cf",
  "#a1a1aa",
  "#3f3f46",
  "#2c2c31",
  "#232327",
  "#18181b",
  "#121214",
  "#09090b",
];

const red: MantineColorsTuple = [
  "#ffebeb",
  "#fad7d7",
  "#eeadad",
  "#e3807f",
  "#da5a59",
  "#d54241",
  "#d43535",
  "#bc2727",
  "#a82022",
  "#93151b",
];

export const theme = createTheme({
  primaryColor: "vandyBlack",
  // Keep Mantine's default primaryShade (6 light / 8 dark) so every OTHER color
  // (gold, red, …) resolves to its correct filled shade. The primary alone is
  // inverted to near-white in dark mode via the resolver's dark overrides.
  autoContrast: true,
  colors: {
    vandyBlack,
    gold,
    gray,
    dark,
    red,
  },
  fontFamily:
    'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  fontFamilyMonospace:
    'JetBrainsMono, ui-monospace, SFMono-Regular, Menlo, Monaco, "Liberation Mono", monospace',
  // Headings inherit the Inter stack (no serif): a clean, app-first hierarchy
  // driven by weight/size rather than a display face.
  defaultRadius: "sm",
  components: {
    Tooltip: Tooltip.extend({
      defaultProps: {
        events: { hover: true, focus: true, touch: false },
      },
    }),
    // Size badges to their content; fit-content collapses inside table cells.
    Badge: Badge.extend({
      styles: (_theme, props) => ({
        root:
          props.fullWidth || props.circle
            ? {}
            : { width: "max-content", maxWidth: "100%" },
      }),
    }),
    Tabs: Tabs.extend({
      vars: (theme, props) => ({
        root: {
          ...(props.color === "dark" && {
            "--tabs-color": "var(--mantine-color-dark-default)",
          }),
        },
      }),
    }),
  },
});

export const mantineCssResolver: CSSVariablesResolver = (theme) => ({
  variables: {
    ...v8CssVariablesResolver(theme).variables,
    "--input-error-size": theme.fontSizes.sm,
  },
  light: {
    ...v8CssVariablesResolver(theme).light,
    "--mantine-color-dimmed": "#4b5563",
    "--mantine-color-dark-light-color": "#4e5359",
    "--mantine-color-dark-light-hover": "var(--mantine-color-gray-light-hover)",
    // Override the semantic error color so input error text / borders /
    // required asterisks meet WCAG AA 4.5:1 contrast on the filled-input
    // background (#f1f3f5). red.6 (#d43535) lands at 4.36:1; red.7 (#bc2727)
    // gives ~5.7:1. Does not affect other red usages.
    "--mantine-color-error": "var(--mantine-color-red-7)",
    // Bump subtle-gray icon/text color from gray.6 (now Zinc #52525b, ~7:1 on
    // filled input) — keep the AA-safe darker shade for subtle icons/text.
    "--mantine-color-gray-light-color": "var(--mantine-color-gray-7)",
    // Bump input placeholder color to a Zinc gray that clears WCAG AA 4.5:1 on
    // the filled-input background (#686868 → 5.01:1 on filled, 5.57:1 on white).
    "--mantine-color-placeholder": "#686868",
    // variant="light" red text → red.7 for AA on the tinted pink background.
    "--mantine-color-red-light-color": "var(--mantine-color-red-7)",
    // variant="light" green text uses a custom dark green (~6.8:1 on the light
    // green bg); Mantine's green.9 fails 4.5:1 there.
    "--mantine-color-green-light-color": "#1B5E20",
    "--mantine-color-orange-light-color": "#a63508",
    // Gold is a bright metal, not ink: any gold TEXT (variant="light"/"subtle",
    // Anchor color="gold") must use the darkened gold-ink (#B08900, ~5:1 on
    // white / ~4.6:1 on the gold tint). Bright gold filled buttons keep black
    // text via autoContrast and are unaffected.
    "--mantine-color-gold-light-color": "var(--mantine-color-gold-8)",
  },
  dark: {
    ...v8CssVariablesResolver(theme).dark,
    "--mantine-color-dark-light-color": "var(--mantine-color-gray-4)",
    "--mantine-color-dark-light-hover": "var(--mantine-color-default-hover)",
    // On dark surfaces gold text can be brighter (index 6) and still clear AA.
    "--mantine-color-gold-light-color": "var(--mantine-color-gold-6)",
    // Invert ONLY the primary for dark mode: a near-white filled button with
    // dark text (shadcn / CCC-sister-app pattern). Other colors keep their
    // default dark shades, so gold/red/etc. filled buttons stay correct.
    "--mantine-primary-color-filled": "var(--mantine-color-vandyBlack-1)",
    "--mantine-primary-color-filled-hover": "var(--mantine-color-vandyBlack-2)",
    "--mantine-primary-color-contrast": "var(--mantine-color-vandyBlack-9)",
  },
});
