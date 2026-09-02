import { FC } from "react";
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { ActionIcon, Tooltip } from "@mantine/core";
import { IconLink } from "@tabler/icons-react";
import { useSetAtom } from "jotai";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import { showLinkMenuAtom } from "@/features/editor/atoms/editor-atoms";
import { ensureLinkableSelection } from "./link-selection";
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
