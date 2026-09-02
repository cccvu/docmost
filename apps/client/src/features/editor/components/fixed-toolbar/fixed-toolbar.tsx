import { FC, useRef } from "react";
import { useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import type { Editor } from "@tiptap/react";
import { pageEditorAtom } from "@/features/editor/atoms/editor-atoms";
import { useToolbarState } from "./use-toolbar-state";
import { BlockTypeGroup } from "./groups/block-type-group";
import { InlineMarksGroup } from "./groups/inline-marks-group";
import { ColorGroup } from "./groups/color-group";
import { ListsGroup } from "./groups/lists-group";
import { AlignmentGroup } from "./groups/alignment-group";
import { MediaGroup } from "./groups/media-group";
import { QuickInsertsGroup } from "./groups/quick-inserts-group";
import { MoreInsertsGroup } from "./groups/more-inserts-group";
import { HistoryGroup } from "./groups/history-group";
import { AskAiGroup } from "./groups/ask-ai-group";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom";
// CCC editor-UX (issue #135): fork-owned toolbar additions.
import { LinkGroup } from "@/features/editor-ux/toolbar/link-group";
import { FontSizeGroup } from "@/features/editor-ux/toolbar/font-size-group";
import { FontFamilyGroup } from "@/features/editor-ux/toolbar/font-family-group";
import { useRovingToolbar } from "@/features/editor-ux/a11y/use-roving-toolbar";
import classes from "./fixed-toolbar.module.css";

type FixedToolbarProps = {
  editor?: Editor | null;
  templateMode?: boolean;
};

export const FixedToolbar: FC<FixedToolbarProps> = ({
  editor: editorProp,
  templateMode = false,
}) => {
  const { t } = useTranslation();
  const editorFromAtom = useAtomValue(pageEditorAtom);
  const editor = editorProp ?? editorFromAtom;
  const state = useToolbarState(editor);
  const workspace = useAtomValue(workspaceAtom);
  const isGenerativeAiEnabled = workspace?.settings?.ai?.generative === true;

  const toolbarRef = useRef<HTMLDivElement>(null);
  useRovingToolbar(toolbarRef, () => editor?.commands.focus());

  if (!editor || !state) return null;

  return (
    <>
      <div
        ref={toolbarRef}
        className={classes.fixedToolbar}
        data-fixed-toolbar="true"
        role="toolbar"
        aria-label={t("Formatting toolbar")}
        onMouseDown={(e) => e.preventDefault()}
      >
        <div className={classes.inner}>
          {/* {isGenerativeAiEnabled && (
            <>
              <AskAiGroup />
              <div className={classes.divider} />
            </>
          )} */}
          <HistoryGroup editor={editor} state={state} />
          <div className={classes.divider} />
          <BlockTypeGroup editor={editor} />
          <div className={classes.divider} />
          <InlineMarksGroup editor={editor} state={state} />
          <FontSizeGroup editor={editor} />
          <FontFamilyGroup editor={editor} />
          <div className={classes.divider} />
          <LinkGroup editor={editor} />
          <ColorGroup editor={editor} />
          <div className={classes.divider} />
          <ListsGroup editor={editor} state={state} />
          <div className={classes.divider} />
          <AlignmentGroup editor={editor} />
          <div className={classes.divider} />
          <MediaGroup editor={editor} templateMode={templateMode} />
          <div className={classes.divider} />
          <QuickInsertsGroup editor={editor} />
          <MoreInsertsGroup editor={editor} templateMode={templateMode} />
        </div>
      </div>
      <div className={classes.spacer} aria-hidden />
    </>
  );
};
