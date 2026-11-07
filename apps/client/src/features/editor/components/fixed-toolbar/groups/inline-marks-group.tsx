import { FC } from "react";
import type { Editor } from "@tiptap/react";
import { ActionIcon, Menu, Tooltip } from "@mantine/core";
import {
  IconBold,
  IconChevronDown,
  IconClearFormatting,
  IconCode,
  IconIndentDecrease,
  IconIndentIncrease,
  IconItalic,
  IconStrikethrough,
  IconSubscript,
  IconSuperscript,
  IconUnderline,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import type { ToolbarState } from "../use-toolbar-state";
import classes from "../fixed-toolbar.module.css";
import { shortcutHint } from "@/features/editor-ux/a11y/shortcut-hint";

interface Props {
  editor: Editor;
  state: ToolbarState;
}

export const InlineMarksGroup: FC<Props> = ({ editor, state }) => {
  const { t } = useTranslation();
  // CCC (issue #135): shortcut hints in tooltips + aria-keyshortcuts.
  const bold = shortcutHint(t("Bold"), "B");
  const italic = shortcutHint(t("Italic"), "I");
  const underline = shortcutHint(t("Underline"), "U");
  const strike = shortcutHint(t("Strikethrough"), "S", { shift: true });

  return (
    <ActionIcon.Group>
      <Tooltip label={bold.tooltip} withArrow>
        <ActionIcon
          variant="subtle"
          color="dark"
          size="md"
          aria-label={t("Bold")}
          aria-keyshortcuts={bold.ariaKeyshortcuts}
          aria-pressed={state.isBold}
          className={clsx({ [classes.active]: state.isBold })}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <IconBold size={16} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label={italic.tooltip} withArrow>
        <ActionIcon
          variant="subtle"
          color="dark"
          size="md"
          aria-label={t("Italic")}
          aria-keyshortcuts={italic.ariaKeyshortcuts}
          aria-pressed={state.isItalic}
          className={clsx({ [classes.active]: state.isItalic })}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <IconItalic size={16} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label={underline.tooltip} withArrow>
        <ActionIcon
          variant="subtle"
          color="dark"
          size="md"
          aria-label={t("Underline")}
          aria-keyshortcuts={underline.ariaKeyshortcuts}
          aria-pressed={state.isUnderline}
          className={clsx({ [classes.active]: state.isUnderline })}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
        >
          <IconUnderline size={16} />
        </ActionIcon>
      </Tooltip>
      {/* CCC (issue #135): strikethrough was hidden behind the chevron despite
          being a common, expected control — surfaced as a visible button. */}
      <Tooltip label={strike.tooltip} withArrow>
        <ActionIcon
          variant="subtle"
          color="dark"
          size="md"
          aria-label={t("Strikethrough")}
          aria-keyshortcuts={strike.ariaKeyshortcuts}
          aria-pressed={state.isStrike}
          className={clsx({ [classes.active]: state.isStrike })}
          onClick={() => editor.chain().focus().toggleStrike().run()}
        >
          <IconStrikethrough size={16} />
        </ActionIcon>
      </Tooltip>
      <Menu shadow="md" position="bottom-start" withArrow={false}>
        <Menu.Target>
          <ActionIcon
            variant="subtle"
            color="dark"
            size="md"
            aria-label={t("More inline formatting")}
          >
            <IconChevronDown size={14} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item
            leftSection={<IconCode size={16} />}
            onClick={() => editor.chain().focus().toggleCode().run()}
          >
            {t("Inline code")}
          </Menu.Item>
          <Menu.Item
            leftSection={<IconSubscript size={16} />}
            onClick={() => editor.chain().focus().toggleSubscript().run()}
          >
            {t("Subscript")}
          </Menu.Item>
          <Menu.Item
            leftSection={<IconSuperscript size={16} />}
            onClick={() => editor.chain().focus().toggleSuperscript().run()}
          >
            {t("Superscript")}
          </Menu.Item>
          <Menu.Divider />
          <Menu.Item
            leftSection={<IconIndentIncrease size={16} />}
            onClick={() => editor.chain().focus().indent().run()}
          >
            {t("Increase indent")}
          </Menu.Item>
          <Menu.Item
            leftSection={<IconIndentDecrease size={16} />}
            onClick={() => editor.chain().focus().outdent().run()}
          >
            {t("Decrease indent")}
          </Menu.Item>
          <Menu.Divider />
          <Menu.Item
            leftSection={<IconClearFormatting size={16} />}
            onClick={() => editor.chain().focus().unsetAllMarks().run()}
          >
            {t("Clear formatting")}
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </ActionIcon.Group>
  );
};
