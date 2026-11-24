import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * wiki-v2 #939: at 320 px (a phone, or 400% zoom) the strip's fixed parts (icon, "Scheduled maintenance", Details,
 * Dismiss) were wider than the screen. The message shrank to nothing and the strip's `overflow: hidden` then clipped
 * the Dismiss button. The texts must be the only things that shrink. #946: below `sm` the strip shows the downtime's
 * short time instead of the message, and the label gives way before the time.
 *
 * jsdom applies no stylesheet, so this reads the CSS. It compares parsed values (the `flex` shorthand expanded into
 * its parts, a zero basis in any unit read as 0), never declarations as exact text. The browser proof is
 * e2e/tests/wiki/announcement.spec.ts (B-44, 320 and 375 px).
 */
const css = readFileSync(resolve(__dirname, "announcement-banner.module.css"), "utf8");

/** The one media block the strip uses: narrow screens (or high zoom). */
const NARROW = "@media (max-width: $mantine-breakpoint-sm)";

interface Rule {
  narrow: boolean;
  selectors: string[];
  decls: Array<[string, string]>;
}

/** Flat rules, each tagged with whether it sits in the narrow media block. Any other at-rule fails the parse. */
function parse(source: string): Rule[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  let media: string | null = null;
  let selector: string | null = null;
  let buf = "";
  for (const ch of text) {
    if (ch === "{") {
      const prelude = buf.trim().replace(/\s+/g, " ");
      buf = "";
      if (prelude.startsWith("@")) {
        if (prelude !== NARROW || media !== null) throw new Error(`unexpected at-rule: ${prelude}`);
        media = prelude;
      } else {
        selector = prelude;
      }
    } else if (ch === "}") {
      if (selector !== null) {
        const decls: Array<[string, string]> = [];
        for (const d of buf.split(";")) {
          const at = d.indexOf(":");
          if (at < 0) continue;
          decls.push([d.slice(0, at).trim(), d.slice(at + 1).trim().replace(/\s+/g, " ")]);
        }
        rules.push({ narrow: media !== null, selectors: selector.split(",").map((s) => s.trim()), decls });
        selector = null;
      } else {
        media = null;
      }
      buf = "";
    } else {
      buf += ch;
    }
  }
  return rules;
}

const RULES = parse(css);

type Width = { narrow?: boolean };

/** The declarations for `selector` that apply at that width, in source order. */
function applying(selector: string, { narrow = false }: Width = {}): Array<[string, string]> {
  return RULES.filter((r) => r.selectors.includes(selector) && (!r.narrow || narrow)).flatMap((r) => r.decls);
}

/** The last value of each property for `selector` at that width. */
function style(selector: string, width: Width = {}): Record<string, string> {
  return Object.fromEntries(applying(selector, width));
}

const ZERO = /^[+-]?0*\.?0+(px|%|em|rem)?$/;
const normBasis = (b: string) => (ZERO.test(b) ? "0" : b);
const isNumber = (v: string) => /^[+-]?(\d+\.?\d*|\.\d+)$/.test(v);

interface Flex {
  grow: number;
  shrink: number;
  basis: string;
}

/** `flex-grow`/`-shrink`/`-basis` for `selector`, from the shorthand or the longhands (initial: 0 1 auto). */
function flexOf(selector: string, width: Width = {}): Flex {
  const f: Flex = { grow: 0, shrink: 1, basis: "auto" };
  for (const [p, v] of applying(selector, width)) {
    if (p === "flex-grow") f.grow = Number(v);
    else if (p === "flex-shrink") f.shrink = Number(v);
    else if (p === "flex-basis") f.basis = normBasis(v);
    else if (p === "flex") {
      const parts = v.split(" ");
      if (v === "none") Object.assign(f, { grow: 0, shrink: 0, basis: "auto" });
      else if (v === "auto") Object.assign(f, { grow: 1, shrink: 1, basis: "auto" });
      else if (v === "initial") Object.assign(f, { grow: 0, shrink: 1, basis: "auto" });
      else if (parts.length === 1)
        Object.assign(f, isNumber(v) ? { grow: Number(v), shrink: 1, basis: "0" } : { grow: 1, shrink: 1, basis: normBasis(v) });
      else if (parts.length === 2)
        Object.assign(
          f,
          isNumber(parts[1])
            ? { grow: Number(parts[0]), shrink: Number(parts[1]), basis: "0" }
            : { grow: Number(parts[0]), shrink: 1, basis: normBasis(parts[1]) },
        );
      else Object.assign(f, { grow: Number(parts[0]), shrink: Number(parts[1]), basis: normBasis(parts[2]) });
    }
  }
  return f;
}

/** Out of the layout but still in the accessibility tree (never `display: none`, which a screen reader skips). */
function expectVisuallyHidden(s: Record<string, string>) {
  expect(s.display).not.toBe("none");
  expect(s.visibility).toBeUndefined();
  expect(s.position).toBe("absolute");
  expect(s.width).toBe("1px");
  expect(s.height).toBe("1px");
  expect(s.overflow).toBe("hidden");
  expect(s["clip-path"]).toBe("inset(50%)");
  expect(s["white-space"]).toBe("nowrap");
}

describe("the CSS test's own helpers", () => {
  it("expands every spelling of the flex shorthand and normalises a zero basis", () => {
    const one = (decl: string): Flex => {
      const saved = RULES.splice(0, RULES.length, ...parse(`.x { ${decl} }`));
      try {
        return flexOf(".x");
      } finally {
        RULES.splice(0, RULES.length, ...saved);
      }
    };
    for (const zero of ["1 1 0", "1 1 0%", "1 1 0px", "1", "1 1", "1 1 0.0rem"]) {
      expect(one(`flex: ${zero}`), zero).toEqual({ grow: 1, shrink: 1, basis: "0" });
    }
    expect(one("flex: auto")).toEqual({ grow: 1, shrink: 1, basis: "auto" });
    expect(one("flex: none")).toEqual({ grow: 0, shrink: 0, basis: "auto" });
    expect(one("flex: 0 1 auto")).toEqual(one("flex-shrink: 1"));
    expect(one("flex-grow: 2; flex-shrink: 0; flex-basis: 0px")).toEqual({ grow: 2, shrink: 0, basis: "0" });
    expect(one("flex: 1 1 0; flex-shrink: 0")).toEqual({ grow: 1, shrink: 0, basis: "0" });
    expect(one("flex: 0 1 10px")).toEqual({ grow: 0, shrink: 1, basis: "10px" });
  });

  it("scopes the narrow media block", () => {
    const saved = RULES.splice(0, RULES.length, ...parse(`.x { display: block } ${NARROW} { .x { display: none } }`));
    try {
      expect(style(".x").display).toBe("block");
      expect(style(".x", { narrow: true }).display).toBe("none");
    } finally {
      RULES.splice(0, RULES.length, ...saved);
    }
  });
});

describe("announcement strip layout CSS", () => {
  it("never shrinks the icon or the actions, at any width", () => {
    for (const narrow of [false, true]) {
      expect(flexOf(".icon", { narrow }).shrink).toBe(0);
      expect(flexOf(".actions", { narrow }).shrink).toBe(0);
    }
  });

  it("keeps the actions at the end of the strip even when no text grows into the room", () => {
    expect(style(".actions")["margin-inline-start"]).toBe("auto");
  });

  it("lets the label shrink with an ellipsis instead of pushing the actions out", () => {
    expect(flexOf(".label")).toMatchObject({ grow: 0, shrink: 1, basis: "auto" });
    const label = style(".label");
    expect(label["min-width"]).toBe("0");
    expect(label.overflow).toBe("hidden");
    expect(label["text-overflow"]).toBe("ellipsis");
  });

  it("gives the message only the room left over (a zero basis)", () => {
    expect(flexOf(".message")).toEqual({ grow: 1, shrink: 1, basis: "0" });
    expect(style(".message")["min-width"]).toBe("0");
  });

  it("lets the time shrink with an ellipsis, so it can never push the actions out either", () => {
    for (const narrow of [false, true]) {
      expect(flexOf(".time", { narrow })).toEqual({ grow: 0, shrink: 1, basis: "auto" });
      const time = style(".time", { narrow });
      expect(time["min-width"]).toBe("0");
      expect(time.overflow).toBe("hidden");
      expect(time["text-overflow"]).toBe("ellipsis");
      expect(time["white-space"]).toBe("nowrap");
    }
  });
});

describe("announcement strip on narrow screens (#946)", () => {
  it("never hides the time (when the downtime is, is what a phone reader needs)", () => {
    for (const sel of [".time", ".timeShort"]) {
      expect(style(sel, { narrow: true }).display, sel).not.toBe("none");
      expect(style(sel, { narrow: true }).visibility, sel).toBeUndefined();
    }
  });

  it("shows the time instead of the message, which stays in the strip for screen readers (and whole in Details)", () => {
    expect(applying(".time ~ .message")).toEqual([]);
    expectVisuallyHidden(style(".time ~ .message", { narrow: true }));
    // Without a downtime there is no time: the message keeps its place.
    expect(style(".message", { narrow: true }).display).not.toBe("none");
    expect(style(".message", { narrow: true }).position).toBeUndefined();
  });

  it("swaps the long time for the short one (no year); the long one stays the spoken text", () => {
    expect(style(".timeShort").display).toBe("none");
    expect(style(".timeLong").display).toBeUndefined();
    expectVisuallyHidden(style(".timeLong", { narrow: true }));
  });

  it("lets the label give way before the time: it takes only the room the time leaves, up to its own width", () => {
    // A zero basis never weighs in the shrink, so the time shrinks only once the label is gone; growing back is
    // capped at the label's own width.
    expect(flexOf(".label:has(~ .time)", { narrow: true })).toMatchObject({ basis: "0" });
    expect(flexOf(".label:has(~ .time)", { narrow: true }).grow).toBeGreaterThan(0);
    expect(style(".label:has(~ .time)", { narrow: true })["max-width"]).toBe("max-content");
    // Wide screens keep the plain label rule.
    expect(applying(".label:has(~ .time)")).toEqual([]);
  });
});
