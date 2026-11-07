/**
 * CCC render gate for colour values (#145).
 *
 * Stock Tiptap `Color` and `Highlight` interpolate the stored attribute
 * straight into inline CSS (`color: ${value}`). Content authored as JSON (the
 * /v1 API, MCP) or over Yjs never passes `parseHTML`, so a value such as
 * `red; background-image:url(https://…)` became a second CSS declaration in
 * the live editor, share pages and HTML exports (beacons, IP leaks, overlays).
 *
 * This grammar is deliberately permissive about COLOURS and strict about
 * SYNTAX: every form it accepts is a single CSS colour token with no `;`, `:`,
 * quotes, `url(`, escapes or nested functions, so it cannot open a second
 * declaration or load a resource.
 *
 *   - `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`
 *   - `rgb()`/`rgba()`/`hsl()`/`hsla()` whose arguments are only numbers,
 *     signs, `.`, `%`, `deg`, commas, spaces and `/` (legacy and modern syntax)
 *   - a bare named colour (`red`, `transparent`, `currentcolor`, `windowtext`)
 *   - a custom property reference `var(--name)`
 *
 * It accepts every swatch the UI offers (TEXT_COLORS / HIGHLIGHT_COLORS are
 * `#rrggbb`) and the forms a browser's `element.style` reports on import.
 */
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const COLOR_FUNCTION = /^(?:rgba?|hsla?)\((?:[\d.+\-%\s,/]|deg)+\)$/i;
const NAMED = /^[a-z]+$/i;
const CUSTOM_PROPERTY = /^var\(--[a-z0-9-]+\)$/i;

/** The trimmed value when it is a safe single CSS colour token, else null. */
export function safeCssColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (
    HEX.test(v) ||
    COLOR_FUNCTION.test(v) ||
    NAMED.test(v) ||
    CUSTOM_PROPERTY.test(v)
  ) {
    return v;
  }
  return null;
}
