import { FC } from "react";
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { ActionIcon, Menu, Tooltip } from "@mantine/core";
import { IconCheck, IconLetterCase } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { FONT_FAMILY_OPTIONS } from "@docmost/editor-ext";
import { collectTextStyleAttr } from "./selection-attr";

interface Props {
  editor: Editor;
}

/**
 * CCC editor-UX (issue #135): controlled font-family menu (Default / Serif /
 * Monospace). Applies allowlisted keyword values via the fork `CccFontFamily`
 * command (attr on the `textStyle` mark). Disabled inside code blocks.
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
    <Menu shadow="md" position="bottom-start" withArrow={false}>
      <Menu.Target>
        <Tooltip label={t("Font")} withArrow>
          <ActionIcon
            variant="subtle"
            color="dark"
            size="md"
            aria-label={t("Font")}
            disabled={state.disabled}
          >
            <IconLetterCase size={16} />
          </ActionIcon>
        </Tooltip>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>{t("Font")}</Menu.Label>
        {FONT_FAMILY_OPTIONS.map((option) => {
          const active = state.current === option.value;
          return (
            <Menu.Item
              key={option.label}
              rightSection={active ? <IconCheck size={14} /> : null}
              onClick={() => apply(option.value)}
            >
              {t(option.label)}
            </Menu.Item>
          );
        })}
      </Menu.Dropdown>
    </Menu>
  );
};
