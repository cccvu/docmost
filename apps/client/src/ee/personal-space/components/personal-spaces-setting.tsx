import { Group, Text, Switch } from "@mantine/core";
import { useAtom } from "jotai";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { updateWorkspace } from "@/features/workspace/services/workspace-service.ts";
import { notifications } from "@mantine/notifications";
import { useHasFeature } from "@/ee/hooks/use-feature";
import { Feature } from "@/ee/features";

export default function PersonalSpacesSetting() {
  const { t } = useTranslation();
  const hasPersonalSpaces = useHasFeature(Feature.PERSONAL_SPACES);

  // CCC: HIDE the whole personal-spaces row (descriptive text + toggle) when the
  // feature isn't available, instead of rendering it disabled. Internal tool.
  if (!hasPersonalSpaces) {
    return null;
  }

  return (
    <Group justify="space-between" wrap="nowrap" gap="xl">
      <div>
        <Text size="md">{t("Allow personal spaces")}</Text>
        <Text size="sm" c="dimmed">
          {t("Members can create their own personal space.")}
        </Text>
      </div>

      <PersonalSpacesToggle />
    </Group>
  );
}

function PersonalSpacesToggle() {
  const { t } = useTranslation();
  const [workspace, setWorkspace] = useAtom(workspaceAtom);
  const [checked, setChecked] = useState(
    workspace?.settings?.spaces?.allowPersonal === true,
  );
  const hasPersonalSpaces = useHasFeature(Feature.PERSONAL_SPACES);

  // CCC: HIDE the toggle when the feature isn't available (was a disabled Switch
  // with an upgrade tooltip). The control is only rendered when usable.
  if (!hasPersonalSpaces) {
    return null;
  }

  const handleChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.currentTarget.checked;
    try {
      const updatedWorkspace = await updateWorkspace({
        allowPersonalSpaces: value,
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

  return (
    <Switch
      checked={checked}
      onChange={handleChange}
      aria-label={t("Toggle allow personal spaces")}
    />
  );
}
