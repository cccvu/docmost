import { FC, useEffect, useRef } from "react";
import type { Editor } from "@tiptap/react";
import type { Transaction } from "@tiptap/pm/state";
import { useEditorState } from "@tiptap/react";
import { ActionIcon, Tooltip } from "@mantine/core";
import { IconLink } from "@tabler/icons-react";
import { useAtom } from "jotai";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import { showLinkMenuAtom } from "@/features/editor/atoms/editor-atoms";
import {
  ensureLinkableSelection,
  shouldRemovePlaceholder,
  type PlaceholderRange,
} from "./link-selection";
import classes from "@/features/editor/components/fixed-toolbar/fixed-toolbar.module.css";

/**
 * CCC editor-UX (issue #135): a toolbar Link button. Establishes a non-empty,
 * linkable selection (see `ensureLinkableSelection`) then opens the shared
 * upstream link panel via `showLinkMenuAtom`.
 */

interface Props {
  editor: Editor;
}

export const LinkGroup: FC<Props> = ({ editor }) => {
  const { t } = useTranslation();
  const [showLinkMenu, setShowLinkMenu] = useAtom(showLinkMenuAtom);

  // The "link" placeholder text this button last inserted into an empty caret,
  // pending confirmation. Cleaned up on a cancelled panel (effect below).
  const placeholderRef = useRef<PlaceholderRange | null>(null);
  const wasOpenRef = useRef(showLinkMenu);

  const isActive = useEditorState({
    editor,
    selector: (ctx) => !!ctx.editor?.isActive("link"),
  });

  // Keep the pending placeholder range accurate across document changes — local
  // edits AND remote collaborative (Yjs/Hocuspocus) transactions all arrive
  // here — by mapping it through each transaction. Without this the stored
  // absolute offsets would go stale if a concurrent edit landed before the
  // placeholder while the panel is open, and the cancel-cleanup below could
  // delete the wrong content or throw on an out-of-range position.
  useEffect(() => {
    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      const range = placeholderRef.current;
      if (!range || !transaction.docChanged) return;
      placeholderRef.current = {
        from: transaction.mapping.map(range.from, -1),
        to: transaction.mapping.map(range.to, 1),
      };
    };
    editor.on("transaction", onTransaction);
    return () => {
      editor.off("transaction", onTransaction);
    };
  }, [editor]);

  // When the panel closes (showLinkMenu: true → false), remove a placeholder we
  // inserted UNLESS a link was actually applied to it — so dismissing the panel
  // (Escape / click-away) never leaves stray "link" text behind (issue #135).
  // `shouldRemovePlaceholder` is the safety gate: it deletes only the exact,
  // still-present placeholder text, so a stale/rewritten range is left alone.
  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = showLinkMenu;
    const range = placeholderRef.current;
    if (!wasOpen || showLinkMenu || !range) return;
    placeholderRef.current = null;
    if (shouldRemovePlaceholder(editor, range)) {
      editor.chain().deleteRange(range).run();
    }
  }, [showLinkMenu, editor]);

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
          const { placeholder } = ensureLinkableSelection(editor);
          placeholderRef.current = placeholder;
          setShowLinkMenu(true);
        }}
      >
        <IconLink size={16} />
      </ActionIcon>
    </Tooltip>
  );
};
