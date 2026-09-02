import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
// CCC (issue #135): delegate to a fork pure function so INTERNAL ProseMirror
// copy/paste preserves supported formatting while EXTERNAL pastes are still
// sanitized. Keeps the sanitizer testable and the upstream file a one-liner.
import { cleanPastedHtml } from "@/features/editor-ux/paste/clean-pasted-html";

export const CleanStyles = Extension.create({
  name: "cleanStyles",
  priority: 80,

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("cleanStyles"),
        props: {
          transformPastedHTML(html) {
            return cleanPastedHtml(html);
          },
        },
      }),
    ];
  },
});
