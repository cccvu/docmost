import { FC, ReactNode, useId, useState } from "react";
import { ActionIcon, Menu, Tooltip } from "@mantine/core";
import { IconCheck } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

export interface TextStyleOption {
  /** English-text i18n key. */
  label: string;
  /** Stored attr value, or null for the default (no attribute). */
  value: string | null;
}

// Mantine radio items take a string value; the default option's is null.
const DEFAULT_VALUE = "__default__";

/** i18n key naming the current value: an option label, or "Mixed". */
function textStyleValueKey(
  current: string | null | "mixed",
  options: readonly TextStyleOption[],
): string {
  if (current === "mixed") return "Mixed";
  const match =
    options.find((o) => o.value === current) ??
    options.find((o) => o.value === null);
  return match?.label ?? "";
}

interface Props {
  /** Translated control name, e.g. t("Font size"). */
  label: string;
  icon: ReactNode;
  options: readonly TextStyleOption[];
  current: string | null | "mixed";
  disabled: boolean;
  onSelect: (value: string | null) => void;
}

/**
 * CCC editor-UX (issue #145): the shared font size / font family menu.
 *  - The options are a `menuitemradio` group with `aria-checked` on the active
 *    value (Mantine `Menu.RadioGroup`); a selection spanning several values
 *    checks none.
 *  - The trigger's name and tooltip carry the value ("Font size: Large",
 *    "Font size: Mixed"), and the dropdown header shows it visibly.
 *  - The menu is controlled so `aria-haspopup`/`aria-expanded` sit on the
 *    button: Menu.Target would put them on the Tooltip between the two, which
 *    spreads them onto its floating label instead (upstream's
 *    text-alignment-selector works around it the same way). For the same
 *    reason the dropdown is labelled by its own visible header, not by the
 *    target id Mantine would point at.
 */
export const TextStyleMenu: FC<Props> = ({
  label,
  icon,
  options,
  current,
  disabled,
  onSelect,
}) => {
  const { t } = useTranslation();
  const [opened, setOpened] = useState(false);
  const headerId = useId();

  const name = `${label}: ${t(textStyleValueKey(current, options))}`;
  const selected = current === "mixed" ? null : (current ?? DEFAULT_VALUE);

  return (
    <Menu
      shadow="md"
      position="bottom-start"
      withArrow={false}
      opened={opened}
      onChange={setOpened}
      checkIcon={<IconCheck size={14} />}
    >
      <Menu.Target>
        <Tooltip label={name} withArrow disabled={opened}>
          <ActionIcon
            variant="subtle"
            color="dark"
            size="md"
            aria-label={name}
            aria-haspopup="menu"
            aria-expanded={opened}
            disabled={disabled}
          >
            {icon}
          </ActionIcon>
        </Tooltip>
      </Menu.Target>
      <Menu.Dropdown aria-labelledby={headerId}>
        <Menu.Label id={headerId}>{name}</Menu.Label>
        <Menu.RadioGroup
          value={selected}
          onChange={(value) => onSelect(value === DEFAULT_VALUE ? null : value)}
        >
          {options.map((option) => (
            <Menu.RadioItem
              key={option.label}
              value={option.value ?? DEFAULT_VALUE}
              closeMenuOnClick
            >
              {t(option.label)}
            </Menu.RadioItem>
          ))}
        </Menu.RadioGroup>
      </Menu.Dropdown>
    </Menu>
  );
};
