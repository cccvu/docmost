import { format as dateFnsFormat, type Locale } from "date-fns";
import { enUS } from "date-fns/locale/en-US";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n.ts";

// #408: only the active locale enters the bundle. en-US is the static default + fallback (it is the app's
// fallbackLng and needed synchronously everywhere); every other locale is a lazy chunk loaded on demand.
// preloadDateFnsLocale() is awaited immediately before i18n.changeLanguage() at the two language-set points
// (features/user/user-provider.tsx and features/user/components/account-language.tsx), so by the time any
// component renders for a new language its Locale is already cached and getDateFnsLocale() stays a pure
// synchronous getter with zero flash. Loaders use LITERAL import() specifiers so Rolldown emits one chunk per
// locale — a computed `import(`date-fns/locale/${code}`)` would glob-bundle every date-fns locale. i18n codes
// map to date-fns subpaths, which differ (de-DE -> de, pt-BR -> pt-BR, uk-UA -> uk, …).
const LOADERS: Record<string, () => Promise<Locale>> = {
  "de-DE": () => import("date-fns/locale/de").then((m) => m.de),
  "es-ES": () => import("date-fns/locale/es").then((m) => m.es),
  "fr-FR": () => import("date-fns/locale/fr").then((m) => m.fr),
  "it-IT": () => import("date-fns/locale/it").then((m) => m.it),
  "ja-JP": () => import("date-fns/locale/ja").then((m) => m.ja),
  "ko-KR": () => import("date-fns/locale/ko").then((m) => m.ko),
  "nl-NL": () => import("date-fns/locale/nl").then((m) => m.nl),
  "pt-BR": () => import("date-fns/locale/pt-BR").then((m) => m.ptBR),
  "ru-RU": () => import("date-fns/locale/ru").then((m) => m.ru),
  "uk-UA": () => import("date-fns/locale/uk").then((m) => m.uk),
  "zh-CN": () => import("date-fns/locale/zh-CN").then((m) => m.zhCN),
};

const cache = new Map<string, Locale>([["en-US", enUS]]);
const inFlight = new Map<string, Promise<void>>();

// i18n.language is always one of the 12 region-qualified codes (or "en-US"): match it exactly, else fall back
// to en-US — the same result the previous LOCALE_MAP lookup produced (its base-language branch never matched a
// region-qualified key).
function resolveCode(language?: string): string {
  const lang = language ?? i18n.language ?? "en-US";
  return lang === "en-US" || LOADERS[lang] ? lang : "en-US";
}

// Load the date-fns locale for `language` into the cache so getDateFnsLocale() can return it synchronously.
// Best-effort: a failed load leaves en-US as the fallback and the promise still resolves (callers gate a
// language switch on it, so it must always settle). Concurrent calls for the same code share one load.
export async function preloadDateFnsLocale(language?: string): Promise<void> {
  const code = resolveCode(language);
  if (cache.has(code)) return;
  let pending = inFlight.get(code);
  if (!pending) {
    pending = LOADERS[code]()
      .then((locale) => {
        cache.set(code, locale);
      })
      .catch(() => {
        // keep en-US as the fallback
      })
      .finally(() => {
        inFlight.delete(code);
      });
    inFlight.set(code, pending);
  }
  await pending;
}

// Switch the app language, loading its date-fns locale FIRST so every synchronous getDateFnsLocale() consumer
// (including the non-hook utils lib/time.ts and features/label/utils/format-label-date.ts) renders the correct
// locale on its first render for the new language — no flash, no store, no re-render trigger. This is the ONLY
// supported way to change the app language: call it instead of i18n.changeLanguage() directly. The
// preload-before-switch ordering is load-bearing (a concurrent load would let a translation-namespace fetch win
// the race and strand non-hook date consumers on en-US), and it is enforced by date-locale.test.ts, which fails
// if any non-test client file calls i18n.changeLanguage() outside this module. Preload failures fall back to en-US.
export async function changeAppLanguage(language: string): Promise<void> {
  await preloadDateFnsLocale(language);
  await i18n.changeLanguage(language);
}

export function getDateFnsLocale(language?: string): Locale {
  return cache.get(resolveCode(language)) ?? enUS;
}

export function useDateFnsLocale(): Locale {
  const { i18n: instance } = useTranslation();
  return getDateFnsLocale(instance.language);
}

function isEnglishLocale(locale: Locale): boolean {
  return locale.code === "en-US" || locale.code?.startsWith("en") === true;
}

/**
 * Picks `enUSPattern` for the English locale and `localizedPattern` for every
 * other locale. Keeps existing en-US output byte-identical while letting other
 * languages use date-fns localized format tokens (P, PP, p, PPp, …).
 */
export function formatLocalized(
  date: Date | number | string,
  enUSPattern: string,
  localizedPattern: string,
  locale?: Locale,
): string {
  const effective = locale ?? getDateFnsLocale();
  const pattern = isEnglishLocale(effective) ? enUSPattern : localizedPattern;
  return dateFnsFormat(new Date(date), pattern, { locale: effective });
}
