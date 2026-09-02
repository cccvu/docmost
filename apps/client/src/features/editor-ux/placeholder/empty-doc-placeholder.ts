import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import i18n from "@/i18n.ts";

/**
 * CCC editor-UX (issue #135): blank-page placeholder.
 *
 * Upstream `@tiptap/extensions` Placeholder (v3.27) only renders its decorations
 * while the editor `isFocused` (and only on the cursor's node), so a freshly
 * opened, empty, editable page showed NO "Write anything…" invitation until the
 * user clicked in — the page looked dead (the #135 audit bug).
 *
 * This complements — never replaces — the upstream Placeholder: it decorates the
 * first block of an EMPTY, EDITABLE, UNFOCUSED document with the same
 * `is-editor-empty` class + `data-placeholder` attribute the upstream CSS
 * already styles (`placeholder.css`). Once the editor gains focus the upstream
 * placeholder takes over, so there is never a doubled placeholder. Focus/blur
 * dispatch a no-op transaction so the decoration is recomputed at the moment
 * focus changes.
 */
export const EmptyDocPlaceholder = Extension.create({
  name: "cccEmptyDocPlaceholder",

  onFocus() {
    // Recompute decorations so this placeholder hides the instant focus lands.
    this.editor.view.dispatch(this.editor.state.tr);
  },

  onBlur() {
    // Recompute so it reappears when focus leaves an empty page.
    this.editor.view.dispatch(this.editor.state.tr);
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey("cccEmptyDocPlaceholder"),
        props: {
          decorations: (state) => {
            if (!editor.isEditable || editor.isFocused) return null;
            if (!editor.isEmpty) return null;
            const first = state.doc.firstChild;
            if (!first) return null;
            return DecorationSet.create(state.doc, [
              Decoration.node(0, first.nodeSize, {
                class: "is-editor-empty",
                "data-placeholder": i18n.t(
                  'Write anything. Enter "/" for commands',
                ),
              }),
            ]);
          },
        },
      }),
    ];
  },
});
