import { Group, Text, SegmentedControl } from "@mantine/core";
import { useAtom } from "jotai";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom.ts";
import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { updateWorkspace } from "@/features/workspace/services/workspace-service.ts";
import { notifications } from "@mantine/notifications";
import { modals } from "@mantine/modals";
import { getApiErrorMessage } from "@/lib/api-error.ts";
import { PageEditMode } from "@/features/user/types/user.types.ts";

export default function WorkspaceDefaultPageEditMode() {
  const { t } = useTranslation();

  return (
    <Group justify="space-between" wrap="nowrap" gap="xl">
      <div>
        <Text size="md">{t("Default page edit mode")}</Text>
        <Text size="sm" c="dimmed">
          {t(
            "The mode pages open in for anyone who hasn't chosen their own. Read prevents accidental edits.",
          )}
        </Text>
      </div>

      <DefaultPageEditModeControl />
    </Group>
  );
}

function DefaultPageEditModeControl() {
  const { t } = useTranslation();
  const [workspace, setWorkspace] = useAtom(workspaceAtom);
  // CCC: Read is the safe default (prevent accidental edits).
  const defaultPageEditMode =
    workspace?.settings?.defaultPageEditMode ?? PageEditMode.Read;
  const [value, setValue] = useState<string>(defaultPageEditMode);

  const applyChange = async (newValue: string) => {
    const prevValue = value;
    setValue(newValue);
    try {
      const updatedWorkspace = await updateWorkspace({
        defaultPageEditMode: newValue,
      });
      setWorkspace(updatedWorkspace);
    } catch (err) {
      setValue(prevValue);
      notifications.show({
        message: getApiErrorMessage(err, t("Failed to update setting")),
        color: "red",
      });
    }
  };

  const handleChange = (newValue: string) => {
    // CCC (#6): warn before making Edit the default — it opens pages editable for
    // everyone without their own preference (accidental-edit risk).
    if (newValue === PageEditMode.Edit) {
      modals.openConfirmModal({
        title: t("Are you sure you want pages to open in Edit mode by default?"),
        centered: true,
        children: (
          <Text size="sm">
            {t(
              "Read mode is the safe default — it prevents accidental edits. Setting Edit as the default means pages open editable for everyone who hasn't chosen their own mode.",
            )}
          </Text>
        ),
        labels: { confirm: t("Set Edit as default"), cancel: t("Cancel") },
        confirmProps: { color: "red" },
        onConfirm: () => applyChange(newValue),
      });
      return;
    }
    applyChange(newValue);
  };

  useEffect(() => {
    if (defaultPageEditMode !== value) {
      setValue(defaultPageEditMode);
    }
  }, [defaultPageEditMode, value]);

  return (
    <SegmentedControl
      aria-label={t("Default page edit mode")}
      value={value}
      onChange={handleChange}
      data={[
        { label: t("Edit"), value: PageEditMode.Edit },
        { label: t("Read"), value: PageEditMode.Read },
      ]}
    />
  );
}
