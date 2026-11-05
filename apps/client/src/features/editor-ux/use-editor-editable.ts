import type { Editor } from "@tiptap/core";
import { useCallback, useSyncExternalStore } from "react";

/**
 * CCC (#407 follow-up): `editor.isEditable`, re-rendering when it changes. A ReactNodeView does not
 * re-render on `editor.setEditable()`, so reading the getter at render time goes stale (pages open in
 * Read mode, so a code block's language picker stayed disabled after switching to Edit). `useEditorState`
 * does not help: it listens to 'transaction', and setEditable emits only 'update'.
 */
export function useEditorEditable(editor: Editor): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      editor.on("update", onChange);
      return () => {
        editor.off("update", onChange);
      };
    },
    [editor],
  );
  return useSyncExternalStore(subscribe, () => editor.isEditable);
}
