import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * wiki-v2 #906: default inputs showed no focus. a11y-overrides.css pinned `border-color` on
 * `.mantine-Input-input`, and Mantine 9 shows focus (and the red error border) only by changing `--input-bd`, which
 * the pin cut out. jsdom applies no stylesheet, so this reads the CSS as text; the browser proof is
 * e2e/tests/wiki/focus-visible.spec.ts.
 */
const SRC = resolve(__dirname, "../..");
const overrides = readFileSync(
  resolve(SRC, "styles/a11y-overrides.css"),
  "utf8",
);
const mantineInputCss = readFileSync(
  createRequire(import.meta.url).resolve("@mantine/core/styles/Input.css"),
  "utf8",
);

type Rule = { selector: string; body: string };

/** Flat `selector { body }` rules, comments stripped and whitespace collapsed (no nesting in these files). */
function rules(css: string): Rule[] {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
  return [...flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1].trim(),
    body: m[2].trim(),
  }));
}

function declares(body: string, property: string, value?: string): boolean {
  return body
    .split(";")
    .map((d) => d.split(":").map((x) => x.trim()))
    .some(
      ([p, ...v]) =>
        p === property && (value === undefined || v.join(":") === value),
    );
}

const ours = rules(overrides);

describe("a11y-overrides.css: input borders and focus (#906)", () => {
  it("never pins a border on the input itself (Mantine's focus and error borders read --input-bd)", () => {
    const pins = ours.filter(
      (r) =>
        r.selector.includes(".mantine-Input-input") &&
        /(^|;)\s*border(-color|-top-color|-right-color|-bottom-color|-left-color)?\s*:/.test(
          r.body,
        ),
    );
    expect(pins).toEqual([]);
  });

  it.each([
    ["light", "var(--mantine-color-gray-6)"],
    ["dark", "var(--mantine-color-dark-3)"],
  ])(
    "sets the %s resting border as --input-bd on the default-variant wrapper",
    (scheme, value) => {
      const selector = `[data-mantine-color-scheme="${scheme}"] .mantine-Input-wrapper[data-variant="default"]`;
      expect(
        ours.some(
          (r) =>
            r.selector === selector && declares(r.body, "--input-bd", value),
        ),
      ).toBe(true);
    },
  );

  it.each([
    ["light", "var(--mantine-primary-color-filled)"],
    ["dark", "var(--mantine-color-brandBlack-1)"],
  ])("defines the %s focus-ring colour", (scheme, value) => {
    expect(
      ours.some(
        (r) =>
          r.selector === `[data-mantine-color-scheme="${scheme}"]` &&
          declares(r.body, "--ccc-focus-ring", value),
      ),
    ).toBe(true);
  });

  it("rings every styled input on focus and focus-within with a 2px outline", () => {
    const ring = ours.find(
      (r) =>
        r.selector ===
        '.mantine-Input-input:not([data-variant="unstyled"]):is(:focus, :focus-within)',
    );
    expect(ring).toBeDefined();
    expect(
      declares(ring!.body, "outline", "2px solid var(--ccc-focus-ring)"),
    ).toBe(true);
    expect(declares(ring!.body, "outline-offset", "2px")).toBe(true);
  });

  it("points Mantine's own dark focus rings and dark focus border at the visible colour", () => {
    const darkRing = ours.find(
      (r) =>
        r.selector.includes(
          '[data-mantine-color-scheme="dark"] .mantine-focus-auto:focus-visible',
        ) &&
        r.selector.includes(
          '[data-mantine-color-scheme="dark"] .mantine-focus-always:focus',
        ),
    );
    expect(darkRing).toBeDefined();
    expect(
      declares(darkRing!.body, "outline-color", "var(--ccc-focus-ring)"),
    ).toBe(true);
    expect(
      ours.some(
        (r) =>
          r.selector ===
            '[data-mantine-color-scheme="dark"] .mantine-Input-wrapper:not([data-variant="unstyled"])' &&
          declares(r.body, "--input-bd-focus", "var(--ccc-focus-ring)"),
      ),
    ).toBe(true);
  });

  it("loads after Mantine's styles, so its equal-specificity wrapper rules win", () => {
    const main = readFileSync(resolve(SRC, "main.tsx"), "utf8");
    const mantine = main.indexOf('"@mantine/core/styles.css"');
    const ours = main.indexOf('"@/styles/a11y-overrides.css"');
    expect(mantine).toBeGreaterThanOrEqual(0);
    expect(ours).toBeGreaterThan(mantine);
  });
});

// The fix leans on how Mantine 9 draws inputs. An upgrade that changes it must fail here, not silently in a browser.
describe("Mantine's Input.css still works the way the fix assumes", () => {
  const mantine = rules(mantineInputCss);

  it("the input border reads --input-bd", () => {
    expect(
      mantine.some(
        (r) =>
          r.selector === ".m_8fb7ebe7" &&
          /(^|; )border: [^;]+ solid var\(--input-bd\)(;|$)/.test(r.body),
      ),
    ).toBe(true);
  });

  it("focus swaps --input-bd and removes the outline", () => {
    const focus = mantine.find(
      (r) => r.selector === ".m_8fb7ebe7:focus, .m_8fb7ebe7:focus-within",
    );
    expect(focus).toBeDefined();
    expect(declares(focus!.body, "--input-bd", "var(--input-bd-focus)")).toBe(
      true,
    );
    expect(declares(focus!.body, "outline", "none")).toBe(true);
  });

  it.each(["light", "dark"])(
    "the %s default variant sets --input-bd on the wrapper at the specificity ours matches",
    (scheme) => {
      expect(
        mantine.some(
          (r) =>
            r.selector ===
              `[data-mantine-color-scheme='${scheme}'] .m_6c018570[data-variant='default']` &&
            declares(r.body, "--input-bd"),
        ),
      ).toBe(true);
    },
  );
});
