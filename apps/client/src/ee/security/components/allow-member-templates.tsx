import { Group, Text, Switch } from "@mantine/core";
import { useAtom } from "jotai";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { updateWorkspace } from "@/features/workspace/services/workspace-service.ts";
import { notifications } from "@mantine/notifications";
import { useHasFeature } from "@/ee/hooks/use-feature";
import { Feature } from "@/ee/features";

export default function AllowMemberTemplates() {
  const { t } = useTranslation();
  const hasTemplates = useHasFeature(Feature.TEMPLATES);

  // CCC: HIDE the whole row (description + toggle) when templates aren't
  // available, rather than showing it with a disabled control. Internal tool.
  if (!hasTemplates) return null;

  return (
    <Group justify="space-between" wrap="nowrap" gap="xl">
      <div>
        <Text size="md">{t("Allow members to create templates")}</Text>
        <Text size="sm" c="dimmed">
          {t(
            "Allow non-admin members to create and manage templates in their spaces.",
          )}
        </Text>
      </div>

      <AllowMemberTemplatesToggle />
    </Group>
  );
}

function AllowMemberTemplatesToggle() {
  const { t } = useTranslation();
  const [workspace, setWorkspace] = useAtom(workspaceAtom);
  const [checked, setChecked] = useState(
    workspace?.settings?.templates?.allowMemberTemplates === true,
  );
  const hasTemplates = useHasFeature(Feature.TEMPLATES);

  const handleChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.currentTarget.checked;
    try {
      const updatedWorkspace = await updateWorkspace({
        allowMemberTemplates: value,
      });
      setChecked(value);
      setWorkspace(updatedWorkspace);
    } catch (err) {
      notifications.show({
        message: err?.response?.data?.message,
        color: "red",
      });
    }
  };

  // CCC: HIDE the control when templates aren't available. Internal tool.
  if (!hasTemplates) return null;

  return (
    <Switch
      checked={checked}
      onChange={handleChange}
      aria-label={t("Toggle allow members to create templates")}
    />
  );
}
