import { FC } from "react";
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { IconTextSize } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { FONT_SIZE_OPTIONS } from "@docmost/editor-ext";
import { collectTextStyleAttr } from "./selection-attr";
import { TextStyleMenu } from "./text-style-menu";

interface Props {
  editor: Editor;
}

/**
 * CCC editor-UX (issue #135): controlled font-size menu. Applies allowlisted
 * `fontSize` values via the fork `CccFontSize` command (attr on the `textStyle`
 * mark). Disabled inside code blocks. The active value is a checked
 * `menuitemradio` and part of the trigger's name; a selection spanning several
 * sizes reads "Mixed" (#145, see `TextStyleMenu`).
 */
export const FontSizeGroup: FC<Props> = ({ editor }) => {
  const { t } = useTranslation();

  const state = useEditorState({
    editor,
    selector: (ctx) => ({
      current: ctx.editor ? collectTextStyleAttr(ctx.editor, "fontSize") : null,
      disabled: !!ctx.editor?.isActive("codeBlock"),
    }),
  });

  const apply = (value: string | null) => {
    const chain = editor.chain().focus();
    if (value) chain.setFontSize(value).run();
    else chain.unsetFontSize().run();
  };

  return (
    <TextStyleMenu
      label={t("Font size")}
      icon={<IconTextSize size={16} />}
      options={FONT_SIZE_OPTIONS}
      current={state.current}
      disabled={state.disabled}
      onSelect={apply}
    />
  );
};
