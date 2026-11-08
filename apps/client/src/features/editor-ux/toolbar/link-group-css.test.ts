import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * CCC #145: the fork's LinkGroup reuses the UPSTREAM fixed-toolbar CSS module
 * (for visual parity with the upstream toolbar buttons). A CSS-module import is
 * typed as an index signature, so if an upstream bump renames or drops a class,
 * `classes.<name>` still compiles, yields `undefined`, and the button silently
 * loses its active styling. This reads both sources and fails instead.
 */
const SRC = resolve(__dirname, "../..", ".."); // apps/client/src
const linkGroupPath = join(__dirname, "link-group.tsx");
const linkGroup = readFileSync(linkGroupPath, "utf8");

/** Class names a CSS file defines as selectors (comments stripped). */
function definedClasses(css: string): Set<string> {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const names = new Set<string>();
  for (const m of noComments.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g))
    names.add(m[1]);
  return names;
}

describe("LinkGroup's upstream CSS-module classes (#145)", () => {
  const importMatch = linkGroup.match(
    /import\s+classes\s+from\s+"([^"]+\.module\.css)"/,
  );

  it("imports a CSS module as `classes`", () => {
    expect(importMatch).not.toBeNull();
  });

  const spec = importMatch?.[1] ?? "";
  const cssPath = spec.startsWith("@/")
    ? join(SRC, spec.slice(2))
    : resolve(dirname(linkGroupPath), spec);
  const used = [...linkGroup.matchAll(/\bclasses\.(\w+)/g)].map((m) => m[1]);

  it("uses at least the `active` class", () => {
    expect(used).toContain("active");
  });

  it("every `classes.<name>` it uses is defined in that module", () => {
    const defined = definedClasses(readFileSync(cssPath, "utf8"));
    const missing = [...new Set(used)].filter((name) => !defined.has(name));
    expect(missing).toEqual([]);
  });

  it("the class scan itself rejects an undefined name (anti-vacuity)", () => {
    const defined = definedClasses(
      "/* .commented */ .active,\n.active:hover { color: red; }",
    );
    expect(defined.has("active")).toBe(true);
    expect(defined.has("commented")).toBe(false);
    expect(defined.has("isActive")).toBe(false);
  });
});
