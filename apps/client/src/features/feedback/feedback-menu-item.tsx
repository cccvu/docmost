import { Menu } from "@mantine/core";
import { IconMessageReport } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { FeedbackEntry } from "./use-feedback-entry";

/** The trigger of the Menu that contains `item`: Mantine labels each dropdown by its target's id. */
function menuTriggerOf(item: HTMLElement): HTMLElement | null {
  const id = item.closest("[aria-labelledby]")?.getAttribute("aria-labelledby");
  return id ? document.getElementById(id) : null;
}

/**
 * The avatar menu's "Send feedback" group (#764): its own divider + item, placed above Logout. Closing the dialog
 * returns focus to the menu's trigger (the item itself is gone by then). Renders
 * nothing when the entry is hidden (native mode, or the platform says feedback is off).
 */
export function FeedbackMenuItem({ entry }: { entry: FeedbackEntry }) {
  const { t } = useTranslation();
  if (!entry.visible) return null;
  return (
    <>
      <Menu.Divider />
      <Menu.Item
        onClick={(event) => entry.open(menuTriggerOf(event.currentTarget))}
        leftSection={<IconMessageReport size={16} />}
      >
        {t("Send feedback")}
      </Menu.Item>
    </>
  );
}
