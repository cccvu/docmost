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
 *
 * Deliberate exception (#145): the EE template editor
 * (`ee/template/pages/template-editor.tsx`) keeps upstream's
 * `editorToolbar ?? false`. Templates cannot be used in this deployment: the
 * feature is never entitled, its nav entries are hidden, and no server code
 * serves it (the server `src/ee` stays empty and there is no templates
 * controller). Migrating it would add an upstream seam to dead EE code. If
 * templates are ever enabled, switch that read to resolveEditorToolbarPref.
 */

export const DEFAULT_EDITOR_TOOLBAR_ENABLED = true;

type ToolbarPrefUser = {
  settings?: { preferences?: { editorToolbar?: boolean | null } | null } | null;
} | null;

export function resolveEditorToolbarPref(user?: ToolbarPrefUser): boolean {
  const pref = user?.settings?.preferences?.editorToolbar;
  return pref ?? DEFAULT_EDITOR_TOOLBAR_ENABLED;
}
