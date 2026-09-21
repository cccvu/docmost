import { describe, it, expect } from "vitest";
import { vi } from "vitest";

// date-locale.ts imports the i18n singleton for its default language; stub it so tests do no i18next init /
// network. getDateFnsLocale(undefined) reads this stub's `.language`.
vi.mock("@/i18n.ts", () => ({ default: { language: "en-US" } }));

// Force one locale's dynamic import to fail, to exercise the fallback-to-en-US path (below).
vi.mock("date-fns/locale/de", () => {
  throw new Error("simulated chunk load failure");
});

import {
  getDateFnsLocale,
  preloadDateFnsLocale,
  formatLocalized,
} from "./date-locale";
import { enUS } from "date-fns/locale/en-US";

describe("date-locale (issue #408)", () => {
  it("returns en-US synchronously as the default/fallback before any locale is loaded", () => {
    expect(getDateFnsLocale("en-US").code).toBe("en-US");
    expect(getDateFnsLocale("fr-FR").code).toBe("en-US"); // not loaded yet -> fallback
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
});
