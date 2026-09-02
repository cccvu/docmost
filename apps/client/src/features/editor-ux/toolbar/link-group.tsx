import { FC, useEffect, useRef } from "react";
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { ActionIcon, Tooltip } from "@mantine/core";
import { IconLink } from "@tabler/icons-react";
import { useAtom } from "jotai";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import { showLinkMenuAtom } from "@/features/editor/atoms/editor-atoms";
import {
  ensureLinkableSelection,
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

  // When the panel closes (showLinkMenu: true → false), remove a placeholder we
  // inserted UNLESS a link was actually applied to it — so dismissing the panel
  // (Escape / click-away) never leaves stray "link" text behind (issue #135).
  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = showLinkMenu;
    const range = placeholderRef.current;
    if (!wasOpen || showLinkMenu || !range) return;
    placeholderRef.current = null;

    const linkType = editor.schema.marks.link;
    let linked = false;
    if (linkType) {
      editor.state.doc.nodesBetween(range.from, range.to, (node) => {
        if (node.isText && node.marks.some((m) => m.type === linkType)) {
          linked = true;
        }
      });
    }
    if (!linked) {
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
