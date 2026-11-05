import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { LOWLIGHT_REFRESH_META } from "@docmost/editor-ext";
import { isCodeGrammarsLoaded, loadCodeGrammars } from "./lowlight";

/**
 * CCC (issue #407): starts the lazy grammar load when an editor mounts and, once it lands, dispatches a
 * meta-only transaction the lowlight plugin answers by re-decorating every code block. Meta-only means
 * no doc change: no undo entry, no Yjs update, safe on read-only editors.
 *
 * Plugin state init and plugin view creation run in the same synchronous pass (Tiptap's createView), so
 * "loaded at view time" also means the decorations were built with the grammars.
 */
export const CodeHighlightLoader = Extension.create({
  name: "cccCodeHighlightLoader",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("cccCodeHighlightLoader"),
        view(view) {
          if (!isCodeGrammarsLoaded()) {
            loadCodeGrammars().then(
              () => {
                if (!view.isDestroyed) {
                  view.dispatch(
                    view.state.tr.setMeta(LOWLIGHT_REFRESH_META, true),
                  );
                }
              },
              () => {
                // Already logged by loadCodeGrammars; code stays plain and the next mount retries.
              },
            );
          }
          return {};
        },
      }),
    ];
  },
});
