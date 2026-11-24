import { readdirSync, readFileSync } from "node:fs";
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
const mantineCss = (name: string) =>
  readFileSync(
    createRequire(import.meta.url).resolve(`@mantine/core/styles/${name}.css`),
    "utf8",
  );
const mantineInputCss = mantineCss("Input");

type Rule = { selector: string; body: string };

/** Flat `selector { body }` rules, comments stripped and whitespace collapsed (no nesting in these files). */
function rules(css: string): Rule[] {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
  return [...flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    // Prettier wraps a long `:is(…)` over lines; read `:is( :focus, … )` as `:is(:focus, …)`.
    selector: m[1].trim().replace(/\(\s+/g, "(").replace(/\s+\)/g, ")"),
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

  it("rings every styled input on focus and focus-within with a 2px outline drawn inside the box", () => {
    const ring = ours.find(
      (r) =>
        r.selector ===
        '.mantine-Input-input:not([data-variant="unstyled"]):is(:focus, :focus-within)',
    );
    expect(ring).toBeDefined();
    expect(
      declares(ring!.body, "outline", "2px solid var(--ccc-focus-ring)"),
    ).toBe(true);
    // Inset: an outer ring is clipped by ScrollArea viewports and overflow:hidden modals.
    expect(declares(ring!.body, "outline-offset", "-2px")).toBe(true);
  });

  it("no rule moves an input's ring back outside the box", () => {
    const outward = ours.filter(
      (r) =>
        r.selector.includes(".mantine-Input-input") &&
        r.body
          .split(";")
          .map((d) => d.split(":").map((x) => x.trim()))
          .some(([p, v]) => p === "outline-offset" && !v.startsWith("-")),
    );
    expect(outward).toEqual([]);
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

  it("ring sits inside an error input's 1px red border instead of over it (#915)", () => {
    // The 2px ring at -2px covers the 1px border Mantine turns red on focus; at -3px it spans 1px–3px inside the
    // box, so the red border still shows. Only the offset changes: the ring keeps its neutral colour.
    const errorRing = ours.find(
      (r) =>
        r.selector ===
        '.mantine-Input-input[data-error]:not([data-variant="unstyled"]):is(:focus, :focus-within)',
    );
    expect(errorRing).toBeDefined();
    expect(declares(errorRing!.body, "outline-offset", "-3px")).toBe(true);
    expect(/(^|;)\s*outline(-color)?\s*:/.test(errorRing!.body)).toBe(false);
  });

  it("points the dark Switch and SegmentedControl rings (drawn on a sibling) at the visible colour (#913)", () => {
    const sibling = ours.find(
      (r) =>
        r.selector.includes(
          '[data-mantine-color-scheme="dark"] .mantine-Switch-input:focus-visible + .mantine-Switch-track',
        ) &&
        r.selector.includes(
          '[data-mantine-color-scheme="dark"] .mantine-SegmentedControl-input:focus-visible + .mantine-SegmentedControl-label',
        ),
    );
    expect(sibling).toBeDefined();
    expect(
      declares(sibling!.body, "outline-color", "var(--ccc-focus-ring)"),
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

// #913: Switch and SegmentedControl draw their ring on the element AFTER the hidden input, not via the focus classes.
describe("Mantine's Switch and SegmentedControl rings still work the way the fix assumes", () => {
  it("Switch outlines the track after a focus-visible input", () => {
    const ring = rules(mantineCss("Switch")).find(
      (r) => r.selector === ".m_926b4011:focus-visible + .m_9307d992",
    );
    expect(ring).toBeDefined();
    expect(/(^|; )outline: 2px solid /.test(ring!.body)).toBe(true);
  });

  it("SegmentedControl outlines the label after a focus-visible input, through a variable", () => {
    const seg = rules(mantineCss("SegmentedControl"));
    expect(
      seg.some(
        (r) =>
          r.selector ===
            ".m_1714d588[data-focus-ring='auto']:focus:focus-visible + .m_1738fcb2" &&
          declares(r.body, "--segmented-control-outline"),
      ),
    ).toBe(true);
    expect(
      seg.some(
        (r) =>
          r.selector === ".m_1738fcb2" &&
          declares(r.body, "outline", "var(--segmented-control-outline, none)"),
      ),
    ).toBe(true);
  });
});

/** Every stylesheet under src (plain and CSS modules), as [path relative to src, text]. */
function stylesheets(): [string, string][] {
  return (readdirSync(SRC, { recursive: true }) as string[])
    .filter((f) => f.endsWith(".css"))
    .map((f) => [f, readFileSync(resolve(SRC, f), "utf8")]);
}

/** `property: value` declarations anywhere in a (possibly nested) stylesheet, comments stripped. */
function declarationsOf(css: string, property: RegExp): string[] {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
  return [...flat.matchAll(/(?:^|[;{}])\s*([-a-z]+)\s*:\s*([^;{}]*)/g)]
    .filter((m) => property.test(m[1]))
    .map((m) => `${m[1]}: ${m[2].trim()}`);
}

describe("focus rings and selected markers stay visible in dark (#913)", () => {
  const sheets = stylesheets();

  it("finds the stylesheets (anti-vacuity)", () => {
    expect(sheets.length).toBeGreaterThan(20);
    expect(sheets.some(([f]) => f.endsWith(".module.css"))).toBe(true);
  });

  it("no outline is drawn in the primary filled colour (#0c0c0f in dark, 1.10:1 on the body); use --ccc-focus-ring", () => {
    const offenders = sheets.flatMap(([file, css]) =>
      declarationsOf(css, /^outline(-color)?$/)
        .filter((d) => d.includes("--mantine-primary-color-filled"))
        .map((d) => `${file}: ${d}`),
    );
    expect(offenders).toEqual([]);
  });

  it.each([
    [
      "components/ui/destination-picker/destination-picker.module.css",
      /^border-left$/,
    ],
    ["features/editor/styles/page-break.css", /^border-top-color$/],
  ])(
    "%s marks the selected item in the visible ring colour",
    (file, property) => {
      const decls = declarationsOf(
        readFileSync(resolve(SRC, file), "utf8"),
        property,
      );
      expect(decls.some((d) => d.includes("var(--ccc-focus-ring)"))).toBe(true);
      expect(
        decls.filter((d) => d.includes("--mantine-primary-color-filled")),
      ).toEqual([]);
    },
  );
});

/** The body of the first `{ … }` block after `start` in `css`, brace-matched (nested CSS). */
function blockAfter(css: string, start: RegExp): string | undefined {
  const m = start.exec(css);
  if (!m) return undefined;
  const open = css.indexOf("{", m.index);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  return undefined;
}

describe("link editor input shows one focus ring (#915)", () => {
  it(".linkInput:focus adds no box-shadow beside the global inset ring", () => {
    const css = readFileSync(
      resolve(SRC, "features/editor/components/link/link.module.css"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    const linkInput = blockAfter(css, /\.linkInput\s*\{/);
    expect(linkInput).toBeDefined();
    const focus = blockAfter(linkInput!, /&:focus\s*\{/);
    expect(focus).toBeDefined();
    expect(focus).toMatch(/border-color\s*:/);
    expect(focus).not.toMatch(/box-shadow\s*:/);
  });
});
