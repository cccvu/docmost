import { FC } from "react";
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { ActionIcon, Tooltip } from "@mantine/core";
import { IconLink } from "@tabler/icons-react";
import { useSetAtom } from "jotai";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import { showLinkMenuAtom } from "@/features/editor/atoms/editor-atoms";
import classes from "@/features/editor/components/fixed-toolbar/fixed-toolbar.module.css";

/**
 * CCC editor-UX (issue #135): a toolbar Link button.
 *
 * The upstream link panel (`EditorLinkMenu`) only renders for a NON-EMPTY text
 * selection and links whatever text is selected. A toolbar button, unlike the
 * selection bubble menu, is often clicked with a collapsed caret — so we first
 * establish a linkable selection, then open the shared panel:
 *   - inside an existing link  → select the whole link (edit / remove);
 *   - caret inside a word      → select that word;
 *   - caret in empty space     → insert a "link" placeholder and select it.
 * This keeps all link logic in the fork and touches no upstream file beyond the
 * one-line mount in the toolbar.
 */

const PLACEHOLDER = "link";

function ensureLinkableSelection(editor: Editor): void {
  if (editor.isActive("link")) {
    editor.chain().focus().extendMarkRange("link").run();
    return;
  }

  const { selection } = editor.state;
  if (!selection.empty) {
    editor.commands.focus();
    return;
  }

  const $from = selection.$from;
  const parentText = $from.parent.textContent;
  const offset = $from.parentOffset;
  const base = $from.start();
  const isWordChar = (ch: string | undefined) => !!ch && !/\s/.test(ch);

  let start = offset;
  let end = offset;
  while (start > 0 && isWordChar(parentText[start - 1])) start--;
  while (end < parentText.length && isWordChar(parentText[end])) end++;

  if (end > start) {
    editor
      .chain()
      .focus()
      .setTextSelection({ from: base + start, to: base + end })
      .run();
    return;
  }

  // No word under the caret: insert a placeholder anchor and select it.
  const at = selection.from;
  editor
    .chain()
    .focus()
    .insertContent(PLACEHOLDER)
    .setTextSelection({ from: at, to: at + PLACEHOLDER.length })
    .run();
}

interface Props {
  editor: Editor;
}

export const LinkGroup: FC<Props> = ({ editor }) => {
  const { t } = useTranslation();
  const setShowLinkMenu = useSetAtom(showLinkMenuAtom);

  const isActive = useEditorState({
    editor,
    selector: (ctx) => !!ctx.editor?.isActive("link"),
  });

  return (
    <Tooltip label={t("Add link")} withArrow>
      <ActionIcon
        variant="subtle"
        color="dark"
        size="md"
        aria-label={t("Add link")}
        aria-pressed={isActive}
        className={clsx({ [classes.active]: isActive })}
        onClick={() => {
          ensureLinkableSelection(editor);
          setShowLinkMenu(true);
        }}
      >
        <IconLink size={16} />
      </ActionIcon>
    </Tooltip>
  );
};
