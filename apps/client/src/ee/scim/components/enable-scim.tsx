import { Group, Text, Switch } from "@mantine/core";
import { useAtom } from "jotai";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";
import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { updateWorkspace } from "@/features/workspace/services/workspace-service.ts";
import { notifications } from "@mantine/notifications";
import { useHasFeature } from "@/ee/hooks/use-feature.ts";
import { Feature } from "@/ee/features.ts";

export default function EnableScim() {
  const { t } = useTranslation();
  const [workspace, setWorkspace] = useAtom(workspaceAtom);
  const [checked, setChecked] = useState(workspace?.isScimEnabled ?? false);
  const hasAccess = useHasFeature(Feature.SCIM);

  // CCC: HIDE the whole SCIM row when the feature isn't available (was a
  // disabled toggle with an upgrade tooltip). Internal tool, no paid license.
  if (!hasAccess) {
    return null;
  }

  const handleChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.currentTarget.checked;
    try {
      const updatedWorkspace = await updateWorkspace({ isScimEnabled: value });
      setChecked(value);
      setWorkspace(updatedWorkspace);
    } catch (err) {
      notifications.show({
        message: err?.response?.data?.message,
        color: "red",
      });
    }
  };

  return (
    <Group justify="space-between" wrap="nowrap" gap="xl">
      <div>
        <Text size="md">{t("Enable SCIM")}</Text>
        <Text size="sm" c="dimmed">
          {t(
            "Automatically provision users and groups from your identity provider via SCIM.",
          )}
        </Text>
      </div>

      <Switch
        labelPosition="left"
        defaultChecked={checked}
        onChange={handleChange}
        aria-label={t("Toggle SCIM provisioning")}
      />
    </Group>
  );
}
