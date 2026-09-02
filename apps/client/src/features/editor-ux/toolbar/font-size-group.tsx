import { FC } from "react";
import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { ActionIcon, Menu, Tooltip } from "@mantine/core";
import { IconCheck, IconTextSize } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { FONT_SIZE_OPTIONS } from "@docmost/editor-ext";
import { collectTextStyleAttr } from "./selection-attr";

interface Props {
  editor: Editor;
}

/**
 * CCC editor-UX (issue #135): controlled font-size menu. Applies allowlisted
 * `fontSize` values via the fork `CccFontSize` command (attr on the `textStyle`
 * mark). Disabled inside code blocks; shows a check on the active value and
 * "Mixed" across a multi-size selection.
 */
export const FontSizeGroup: FC<Props> = ({ editor }) => {
  const { t } = useTranslation();

  const state = useEditorState({
    editor,
    selector: (ctx) => ({
      current: ctx.editor
        ? collectTextStyleAttr(ctx.editor, "fontSize")
        : null,
      disabled: !!ctx.editor?.isActive("codeBlock"),
    }),
  });

  const apply = (value: string | null) => {
    const chain = editor.chain().focus();
    if (value) chain.setFontSize(value).run();
    else chain.unsetFontSize().run();
  };

  return (
    <Menu shadow="md" position="bottom-start" withArrow={false}>
      <Menu.Target>
        <Tooltip label={t("Font size")} withArrow>
          <ActionIcon
            variant="subtle"
            color="dark"
            size="md"
            aria-label={t("Font size")}
            disabled={state.disabled}
          >
            <IconTextSize size={16} />
          </ActionIcon>
        </Tooltip>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>{t("Font size")}</Menu.Label>
        {FONT_SIZE_OPTIONS.map((option) => {
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
