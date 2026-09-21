import { describe, it, expect, vi } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

// date-locale.ts imports the i18n singleton for its default language and (via changeAppLanguage) its
// changeLanguage. Stub it so tests do no i18next init / network; the changeLanguage spy is accessible below.
const i18nMock = vi.hoisted(() => ({
  default: {
    language: "en-US",
    changeLanguage: vi.fn((_lng: string) => Promise.resolve()),
  },
}));
vi.mock("@/i18n.ts", () => i18nMock);

// Force one locale's dynamic import to fail, to exercise the fallback-to-en-US path (below). `de-DE` is used
// ONLY by the failed-load test.
vi.mock("date-fns/locale/de", () => {
  throw new Error("simulated chunk load failure");
});

import {
  getDateFnsLocale,
  preloadDateFnsLocale,
  changeAppLanguage,
  formatLocalized,
} from "./date-locale";
import { enUS } from "date-fns/locale/en-US";

describe("date-locale (issue #408)", () => {
  it("returns en-US synchronously as the default/fallback before a locale is loaded", () => {
    // `ko-KR` is reserved: no other test preloads it, so this holds regardless of test order.
    expect(getDateFnsLocale("ko-KR").code).toBe("en-US");
    expect(getDateFnsLocale("en-US").code).toBe("en-US");
    expect(getDateFnsLocale(undefined).code).toBe("en-US"); // i18n stub language
  });

  it("loads a locale on demand, then returns it synchronously (i18n code -> date-fns subpath)", async () => {
    await preloadDateFnsLocale("fr-FR");
    expect(getDateFnsLocale("fr-FR").code).toBe("fr");

    // Hyphenated subpaths must map correctly.
    await preloadDateFnsLocale("pt-BR");
    expect(getDateFnsLocale("pt-BR").code).toBe("pt-BR");

    await preloadDateFnsLocale("zh-CN");
    expect(getDateFnsLocale("zh-CN").code).toBe("zh-CN");
  });

  it("falls back to en-US for an unknown language (no loader, resolves immediately)", async () => {
    await expect(preloadDateFnsLocale("xx-YY")).resolves.toBeUndefined();
    expect(getDateFnsLocale("xx-YY").code).toBe("en-US");
  });

  it("keeps en-US as the fallback when a locale chunk fails to load, and never rejects", async () => {
    await expect(preloadDateFnsLocale("de-DE")).resolves.toBeUndefined();
    expect(getDateFnsLocale("de-DE").code).toBe("en-US");
  });

  it("formatLocalized keeps en-US output byte-identical (uses the en-US pattern for English)", () => {
    // Local-time construction so the assertion is timezone-independent.
    const date = new Date(2026, 0, 2, 3, 4, 5);
    expect(formatLocalized(date, "MMM d, yyyy", "PP", enUS)).toBe("Jan 2, 2026");
  });

  it("formatLocalized uses the LOCALIZED pattern for a non-English locale", async () => {
    await preloadDateFnsLocale("fr-FR");
    const fr = getDateFnsLocale("fr-FR");
    const date = new Date(2026, 0, 2, 3, 4, 5);
    // Distinct single-quoted literal patterns prove which branch ran, independent of locale-specific tokens.
    expect(formatLocalized(date, "'en-branch'", "'other-branch'", enUS)).toBe("en-branch");
    expect(formatLocalized(date, "'en-branch'", "'other-branch'", fr)).toBe("other-branch");
  });

  it("changeAppLanguage loads the date-fns locale BEFORE switching i18n language (ordering)", async () => {
    // `it-IT` is reserved for this test (nothing else preloads it), so it is uncached when we start —
    // the whole point is to prove preload ran before the switch on a FRESH locale.
    let codeAtSwitch: string | undefined;
    i18nMock.default.changeLanguage.mockImplementation((lng: string) => {
      // Capture what getDateFnsLocale returns AT THE MOMENT i18n switches. If the preload ran first (correct),
      // it is already "it"; a change-then-load reordering would observe the "en-US" fallback here and fail.
      codeAtSwitch = getDateFnsLocale(lng).code;
      return Promise.resolve();
    });

    await changeAppLanguage("it-IT");

    expect(i18nMock.default.changeLanguage).toHaveBeenCalledWith("it-IT");
    expect(codeAtSwitch).toBe("it");
    expect(getDateFnsLocale("it-IT").code).toBe("it");
  });

  it("no client code switches the app language outside date-locale.ts (invariant #408)", () => {
    // The synchronous getDateFnsLocale() is only ever correct because every app-language switch preloads the
    // locale first. changeAppLanguage() owns that ordering; a direct i18n.changeLanguage() elsewhere would
    // bypass it and silently regress non-English dates. This is the fitness function that keeps the invariant
    // true as the code evolves (mirrors lazy-pages.test.ts's source pins).
    // vitest runs with cwd at the client package root (apps/client); guard so a wrong cwd fails loudly
    // rather than silently scanning nothing.
    const srcRoot = join(process.cwd(), "src");
    expect(existsSync(join(srcRoot, "lib", "date-locale.ts"))).toBe(true);
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\.(ts|tsx)$/.test(e.name))
          files.push(full);
      }
    };
    walk(srcRoot);

    const callers = files
      .filter((f) => /\bi18n\.changeLanguage\s*\(/.test(readFileSync(f, "utf8")))
      .map((f) => relative(srcRoot, f).split(sep).join("/"))
      .sort();
    // date-locale.ts is the ONLY allowed home for i18n.changeLanguage (inside changeAppLanguage).
    expect(callers).toEqual(["lib/date-locale.ts"]);

    // And the two switch sites must go through the helper.
    const usesHelper = (rel: string) =>
      readFileSync(join(srcRoot, rel), "utf8").includes("changeAppLanguage(");
    expect(usesHelper("features/user/user-provider.tsx")).toBe(true);
    expect(usesHelper("features/user/components/account-language.tsx")).toBe(true);
  });
});
