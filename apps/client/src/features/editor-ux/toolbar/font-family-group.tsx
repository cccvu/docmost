import { FC } from "react";
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { IconLetterCase } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { FONT_FAMILY_OPTIONS } from "@docmost/editor-ext";
import { collectTextStyleAttr } from "./selection-attr";
import { TextStyleMenu } from "./text-style-menu";

interface Props {
  editor: Editor;
}

/**
 * CCC editor-UX (issue #135): controlled font-family menu (Default / Serif /
 * Monospace). Applies allowlisted keyword values via the fork `CccFontFamily`
 * command (attr on the `textStyle` mark). Disabled inside code blocks. Radio
 * semantics, value-in-name and the "Mixed" state come from `TextStyleMenu`
 * (#145).
 */
export const FontFamilyGroup: FC<Props> = ({ editor }) => {
  const { t } = useTranslation();

  const state = useEditorState({
    editor,
    selector: (ctx) => ({
      current: ctx.editor
        ? collectTextStyleAttr(ctx.editor, "fontFamily")
        : null,
      disabled: !!ctx.editor?.isActive("codeBlock"),
    }),
  });

  const apply = (value: string | null) => {
    const chain = editor.chain().focus();
    if (value) chain.setFontFamily(value).run();
    else chain.unsetFontFamily().run();
  };

  return (
    <TextStyleMenu
      label={t("Font")}
      icon={<IconLetterCase size={16} />}
      options={FONT_FAMILY_OPTIONS}
      current={state.current}
      disabled={state.disabled}
      onSelect={apply}
    />
  );
};
