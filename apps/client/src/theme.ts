import {
  Anchor,
  Badge,
  Button,
  createTheme,
  CSSVariablesResolver,
  defaultVariantColorsResolver,
  MantineColorsTuple,
  Tabs,
  Tooltip,
  v8CssVariablesResolver,
  VariantColorsResolver,
} from "@mantine/core";

/*
 * Vanderbilt / College of Connected Computing (CCC) brand theme (issue #30).
 *
 * Design intent: a restrained institutional look. Chrome is near-black on a cool
 * Zinc neutral; Vanderbilt gold is an ACCENT only (CTAs, brand mark), never
 * everyday chrome. The primary filled control is near-black in light and inverts
 * to near-white in dark (shadcn / CCC-sister-app pattern) via the
 * `variantColorResolver` below. Gold text always uses the darkened, AA-safe
 * gold-ink (never bright gold on light — it fails contrast).
 *
 * KEEP IN SYNC with `services/admin-ui/src/theme.ts` — the token tuples and the
 * resolver overrides are copied there (not imported, to respect the AGPL
 * boundary). Any palette/contrast change here must be mirrored in that file.
 */

// Near-black primary (Vanderbilt Black). Shade 6 (the default filled shade) is
// the near-black used for light-mode primary buttons/active states; shade 1
// (near-white) is used for dark-mode primary buttons via the resolver.
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
// hover/active, deep gold-ink at index 9 for gold TEXT (AA on light).
const gold: MantineColorsTuple = [
  "#fffdf2",
  "#fef9e1",
  "#fcf0bd",
  "#f9e38a",
  "#f6d64e",
  "#f3ce24",
  "#f2cc0c", // bright Vanderbilt gold — brand CTA fill
  "#d9b00a",
  "#b08900",
  "#8a6d00", // deepest gold — see gold-ink override for AA gold text
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

// Info blue — the original Docmost blue tuple, retained so the shipped
// components that hard-code color="blue" (invites table, comment tabs, search
// filters) stay brand-controlled instead of falling back to stock Mantine blue.
const blue: MantineColorsTuple = [
  "#e7f3ff",
  "#d0e4ff",
  "#a1c6fa",
  "#6ea6f6",
  "#458bf2",
  "#2b7af1",
  "#0b60d8",
  "#1b72f2",
  "#0056c1",
  "#004aac",
];

// Invert the PRIMARY filled control per scheme. autoContrast can't do this: it
// derives the filled TEXT color from the primary's base shade and ignores
// `--mantine-primary-color-contrast`, so a dark-scheme override of the fill var
// alone yields near-white-on-white. Returning background AND color together —
// from custom scheme-aware vars — keeps them consistent. Scoped to the primary
// color and `filled` variant, so gold/red/blue filled buttons keep autoContrast.
const variantColorResolver: VariantColorsResolver = (input) => {
  const resolved = defaultVariantColorsResolver(input);
  const isPrimary = (input.color ?? input.theme.primaryColor) === input.theme.primaryColor;
  if (input.variant === "filled" && isPrimary) {
    return {
      ...resolved,
      background: "var(--brand-primary-bg)",
      hover: "var(--brand-primary-bg-hover)",
      color: "var(--brand-on-primary)",
    };
  }
  return resolved;
};

export const theme = createTheme({
  primaryColor: "vandyBlack",
  autoContrast: true,
  variantColorResolver,
  colors: {
    vandyBlack,
    gold,
    gray,
    dark,
    red,
    blue,
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
    // A bare <Button> (no variant/color) renders filled by default, but Mantine
    // only emits `--button-bg` when `color || variant` is truthy — so a bare
    // button's background falls back to `--mantine-primary-color-filled` and
    // never reaches the variantColorResolver's inverted `--brand-primary-bg`.
    // Making the default variant explicit fixes that: `--button-bg` is emitted,
    // so bare primary buttons (auth "Sign In", etc.) invert correctly in dark.
    Button: Button.extend({
      defaultProps: { variant: "filled" },
    }),
    // Links always underline: with the near-black primary, the derived anchor
    // color is close to body text, so color alone is not a sufficient link cue
    // (WCAG 1.4.1). A persistent underline is the affordance.
    Anchor: Anchor.extend({
      defaultProps: { underline: "always" },
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
    // Primary filled control: near-black bg + white text in light mode.
    "--brand-primary-bg": "var(--mantine-color-vandyBlack-6)",
    "--brand-primary-bg-hover": "var(--mantine-color-vandyBlack-7)",
    "--brand-on-primary": "var(--mantine-color-white)",
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
    // Anchor color="gold") uses a darkened gold-ink. #b08900 (gold.8) only
    // reaches 3.27:1 on white and FAILS AA; #7a5c00 gives ~6.2:1. Bright gold
    // filled buttons keep black text via autoContrast and are unaffected.
    "--mantine-color-gold-light-color": "#7a5c00",
  },
  dark: {
    ...v8CssVariablesResolver(theme).dark,
    "--mantine-color-dark-light-color": "var(--mantine-color-gray-4)",
    "--mantine-color-dark-light-hover": "var(--mantine-color-default-hover)",
    // On dark surfaces gold text can be brighter (index 6) and still clear AA.
    "--mantine-color-gold-light-color": "var(--mantine-color-gold-6)",
    // Primary filled control inverts in dark: near-white bg + near-black text.
    // Note we do NOT override --mantine-primary-color-filled here, so Checkbox /
    // Switch keep the default near-black fill + white icon (legible in dark).
    "--brand-primary-bg": "var(--mantine-color-vandyBlack-1)",
    "--brand-primary-bg-hover": "var(--mantine-color-vandyBlack-2)",
    "--brand-on-primary": "var(--mantine-color-vandyBlack-9)",
  },
});
