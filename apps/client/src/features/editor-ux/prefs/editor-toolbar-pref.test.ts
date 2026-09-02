import { describe, it, expect } from "vitest";
import {
  DEFAULT_EDITOR_TOOLBAR_ENABLED,
  resolveEditorToolbarPref,
} from "./editor-toolbar-pref";

describe("resolveEditorToolbarPref", () => {
  it("defaults to ON when no preference is stored", () => {
    expect(DEFAULT_EDITOR_TOOLBAR_ENABLED).toBe(true);
    expect(resolveEditorToolbarPref(undefined)).toBe(true);
    expect(resolveEditorToolbarPref(null)).toBe(true);
    expect(resolveEditorToolbarPref({})).toBe(true);
    expect(resolveEditorToolbarPref({ settings: {} })).toBe(true);
    expect(resolveEditorToolbarPref({ settings: { preferences: {} } })).toBe(
      true,
    );
    expect(
      resolveEditorToolbarPref({
        settings: { preferences: { editorToolbar: null } },
      }),
    ).toBe(true);
  });

  it("preserves an explicit opt-out (false)", () => {
    expect(
      resolveEditorToolbarPref({
        settings: { preferences: { editorToolbar: false } },
      }),
    ).toBe(false);
  });

  it("honors an explicit opt-in (true)", () => {
    expect(
      resolveEditorToolbarPref({
        settings: { preferences: { editorToolbar: true } },
      }),
    ).toBe(true);
  });
});
