import { atomWithWebStorage } from "@/lib/jotai-helper.ts";
import { atom } from "jotai";
import {
  SIDEBAR_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_WIDTH_STORAGE_KEY,
} from "@/features/layout/layout-tokens.ts";

export const mobileSidebarAtom = atom<boolean>(false);

export const desktopSidebarAtom = atomWithWebStorage<boolean>(
  "showSidebar",
  true,
);

// CCC (issue: UI polish): the user's chosen sidebar width, persisted to localStorage and
// applied to EVERY sidebar (a single global width — resolves the per-view inconsistency
// that had this removed). The persisted value is shared same-origin with the standalone
// console, which reads/writes the same key independently (no cross-app import; AGPL boundary).
const rawSidebarWidthAtom = atomWithWebStorage<number>(
  SIDEBAR_WIDTH_STORAGE_KEY,
  SIDEBAR_WIDTH,
);

/** Clamp any stored/incoming value into [MIN, MAX]; fall back to the default when it is not
 *  a finite number. `atomWithWebStorage` returns the raw string for numbers on rehydrate, so
 *  coercion here is required — and it also hardens against a corrupt or out-of-range value. */
export function clampSidebarWidth(value: unknown): number {
  // Unset (null/undefined/"") → the default width; anything else is coerced and, if it is not
  // a finite number (e.g. a corrupt string), also falls back to the default.
  if (value == null || value === "") return SIDEBAR_WIDTH;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return SIDEBAR_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(n)));
}

/** Numeric, clamped view over the persisted width: reads coerce+clamp, writes clamp before
 *  persisting. Consumers always see a valid number in [MIN, MAX]. */
export const sidebarWidthAtom = atom<number, [number], void>(
  (get) => clampSidebarWidth(get(rawSidebarWidthAtom)),
  (_get, set, next) => set(rawSidebarWidthAtom, clampSidebarWidth(next)),
);

export const desktopAsideAtom = atom<boolean>(false);

// Valid `tab` values: "" | "comments" | "toc" | "chat" | "details"
type AsideStateType = {
  tab: string;
  isAsideOpen: boolean;
};

export const asideStateAtom = atom<AsideStateType>({
  tab: "",
  isAsideOpen: false,
});