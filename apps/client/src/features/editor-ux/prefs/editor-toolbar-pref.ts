/**
 * CCC editor-UX: single source of truth for the "formatting toolbar" default
 * (issue #135).
 *
 * The fixed formatting toolbar ships ON by default so a non-technical user sees
 * discoverable controls immediately. An explicit user preference (true OR
 * false) is always honored — only the absence of a stored value falls back to
 * the default, so users who previously opted out stay opted out (the pref is a
 * nullable jsonb key; no migration).
 *
 * Read from all three upstream sites (the editor mount, the bubble menu, and
 * the settings toggle) so the default can never drift between them.
 */

export const DEFAULT_EDITOR_TOOLBAR_ENABLED = true;

type ToolbarPrefUser = {
  settings?: { preferences?: { editorToolbar?: boolean | null } | null } | null;
} | null;

export function resolveEditorToolbarPref(user?: ToolbarPrefUser): boolean {
  const pref = user?.settings?.preferences?.editorToolbar;
  return pref ?? DEFAULT_EDITOR_TOOLBAR_ENABLED;
}
