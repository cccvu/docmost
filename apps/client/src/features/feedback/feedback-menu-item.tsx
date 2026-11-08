import { Menu } from "@mantine/core";
import { IconMessageReport } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { FeedbackEntry } from "./use-feedback-entry";

/**
 * The avatar menu's "Send feedback" group (#764): its own divider + item, placed above Logout. Renders
 * nothing when the entry is hidden (native mode, or the platform says feedback is off).
 */
export function FeedbackMenuItem({ entry }: { entry: FeedbackEntry }) {
  const { t } = useTranslation();
  if (!entry.visible) return null;
  return (
    <>
      <Menu.Divider />
      <Menu.Item
        onClick={entry.open}
        leftSection={<IconMessageReport size={16} />}
      >
        {t("Send feedback")}
      </Menu.Item>
    </>
  );
}
