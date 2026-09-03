import { describe, it, expect } from "vitest";
import { getVisibleSlashItems } from "./slash-menu-visibility";
import type { SlashMenuGroupedItemsType } from "./types";

// Minimal fixtures — only the fields the visibility filter reads.
const item = (title: string, requiresBases?: true) =>
  ({ title, requiresBases }) as any;

const grouped = (): SlashMenuGroupedItemsType => ({
  basic: [item("Text"), item("Heading")],
  advanced: [item("Table"), item("Board", true)],
  bases: [item("Base", true)],
});

describe("getVisibleSlashItems", () => {
  it("keeps every command (and category) when bases IS available", () => {
    const { visibleItems, flatItems } = getVisibleSlashItems(grouped(), true);
    expect(Object.keys(visibleItems)).toEqual(["basic", "advanced", "bases"]);
    expect(flatItems.map((i) => i.title)).toEqual([
      "Text",
      "Heading",
      "Table",
      "Board",
      "Base",
    ]);
  });

  it("hides bases-requiring commands and drops now-empty categories when bases is unavailable", () => {
    const { visibleItems, flatItems } = getVisibleSlashItems(grouped(), false);
    // "bases" held ONLY a bases-requiring item → the whole category is dropped.
    expect(Object.keys(visibleItems)).toEqual(["basic", "advanced"]);
    // "Board" (requiresBases) is removed from "advanced"; "Base" is gone with its category.
    expect(flatItems.map((i) => i.title)).toEqual(["Text", "Heading", "Table"]);
  });

  it("keeps flatItems in rendered order so the keyboard flat-index can't point at a hidden row", () => {
    const { visibleItems, flatItems } = getVisibleSlashItems(grouped(), false);
    // The render flattens `visibleItems` in the same category order; the two must match.
    expect(flatItems).toEqual(Object.values(visibleItems).flat());
    expect(flatItems.every((i) => i.requiresBases !== true)).toBe(true);
  });

  it("returns empty structures when every command is filtered out", () => {
    const onlyPaid: SlashMenuGroupedItemsType = { bases: [item("Base", true)] };
    const { visibleItems, flatItems } = getVisibleSlashItems(onlyPaid, false);
    expect(visibleItems).toEqual({});
    expect(flatItems).toEqual([]);
  });
});
