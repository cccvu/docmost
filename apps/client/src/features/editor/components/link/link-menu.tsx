import { FC, useCallback, useEffect, useRef } from "react";
import { BubbleMenu } from "@tiptap/react/menus";
import type { Editor } from "@tiptap/react";
import { useAtom } from "jotai";
import { isTextSelected } from "@docmost/editor-ext";
import { showLinkMenuAtom } from "@/features/editor/atoms/editor-atoms";
import { LinkEditorPanel } from "@/features/editor/components/link/link-editor-panel";
import { normalizeUrl } from "@/lib/utils";
import { TextSelection } from "@tiptap/pm/state";
import { Paper } from "@mantine/core";

type EditorLinkMenuProps = {
  editor: Editor;
};

export const EditorLinkMenu: FC<EditorLinkMenuProps> = ({ editor }) => {
  const [showLinkMenu, setShowLinkMenu] = useAtom(showLinkMenuAtom);
  const showLinkMenuRef = useRef(showLinkMenu);
  // CCC (issue #135): sync the ref during render, not only in the effect below.
  // The BubbleMenu's shouldShow reads this ref on mount (when showLinkMenu flips
  // true); updating it only in a post-mount effect left the first evaluation
  // seeing a stale `false`, so the panel never opened from a programmatic
  // trigger (the toolbar Link button) — and was racy for the bubble link too.
  showLinkMenuRef.current = showLinkMenu;

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    showLinkMenuRef.current = showLinkMenu;
    if (showLinkMenu) {
      editor.commands.focus();
    }
  }, [showLinkMenu, editor]);

  const focusInput = useCallback(() => {
    requestAnimationFrame(() => {
      containerRef.current
        ?.querySelector<HTMLInputElement>("input")
        ?.focus({ preventScroll: true });
    });
  }, []);

  const onSetLink = useCallback(
    (url: string, internal?: boolean) => {
      editor
        .chain()
        .focus()
        .setLink({
          href: internal ? url : normalizeUrl(url),
          internal: !!internal,
        } as any)
        .command(({ tr }) => {
          tr.setSelection(TextSelection.create(tr.doc, tr.selection.to));
          return true;
        })
        .run();
      setShowLinkMenu(false);
    },
    [editor, setShowLinkMenu],
  );

  useEffect(() => {
    if (!showLinkMenu) return;

    const dismiss = () => {
      setShowLinkMenu(false);
      editor.commands.focus();
      editor.commands.setTextSelection(editor.state.selection.to);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        dismiss();
      }
    };

    const handleMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        dismiss();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [showLinkMenu, setShowLinkMenu]);

  if (!showLinkMenu) return null;

  return (
    <BubbleMenu
      editor={editor}
      shouldShow={({ editor, state }) => {
        const { empty } = state.selection;
        return (
          showLinkMenuRef.current &&
          editor.isEditable &&
          !empty &&
          isTextSelected(editor)
        );
      }}
      options={{
        placement: "bottom",
        offset: 8,
        onShow: focusInput,
        onHide: () => {
          setShowLinkMenu(false);
        },
      }}
      style={{ zIndex: 198, position: "relative" }}
    >
      <Paper ref={containerRef} w={320} p="sm" shadow="md" radius={6} withBorder>
        <LinkEditorPanel onSetLink={onSetLink} />
      </Paper>
    </BubbleMenu>
  );
};
