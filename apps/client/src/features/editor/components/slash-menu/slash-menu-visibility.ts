import type {
  SlashMenuGroupedItemsType,
  SlashMenuItemType,
} from "@/features/editor/components/slash-menu/types";

/**
 * CCC (UI consistency): decide which slash-menu commands are VISIBLE and derive the
 * flat, keyboard-navigable order from exactly what will render.
 *
 * Upstream showed unavailable (bases-requiring) commands DISABLED with an "Upgrade"
 * badge; CCC HIDES them instead. Filtering the grouped items — and dropping any
 * category that becomes empty — keeps the flat index used for ArrowUp/ArrowDown/Enter
 * and `aria-activedescendant` in lockstep with the rendered list, so selection can
 * never point at a hidden row. Pure + unit-tested so this (the one real logic change
 * in the slash menu) can't silently regress.
 */
export function getVisibleSlashItems(
  items: SlashMenuGroupedItemsType,
  hasBases: boolean,
): { visibleItems: SlashMenuGroupedItemsType; flatItems: SlashMenuItemType[] } {
  const visibleItems: SlashMenuGroupedItemsType = {};
  for (const [category, categoryItems] of Object.entries(items)) {
    const kept = categoryItems.filter(
      (item) => !(item.requiresBases === true && !hasBases),
    );
    if (kept.length > 0) visibleItems[category] = kept;
  }
  // Flatten in category order — the SAME traversal the render uses — so the flat index
  // is exactly the rendered order.
  const flatItems = Object.values(visibleItems).flat();
  return { visibleItems, flatItems };
}
