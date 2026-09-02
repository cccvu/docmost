import { userAtom } from "@/features/user/atoms/current-user-atom";
import { updateUser } from "@/features/user/services/user-service";
import { Switch, Text } from "@mantine/core";
import { useAtom } from "jotai";
import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ResponsiveSettingsRow,
  ResponsiveSettingsContent,
  ResponsiveSettingsControl,
} from "@/components/ui/responsive-settings-row";
import { resolveEditorToolbarPref } from "@/features/editor-ux/prefs/editor-toolbar-pref";

export default function FixedToolbarPref() {
  const { t } = useTranslation();
  const [user, setUser] = useAtom(userAtom);
  // CCC (issue #135): defaults ON via the shared helper so the toggle's initial
  // state matches what the editor actually shows.
  const [checked, setChecked] = useState(resolveEditorToolbarPref(user));

  const handleChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.currentTarget.checked;
    setChecked(value);
    try {
      const updatedUser = await updateUser({ editorToolbar: value });
      setUser(updatedUser);
    } catch {
      setChecked(!value);
    }
  };

  return (
    <ResponsiveSettingsRow>
      <ResponsiveSettingsContent>
        <Text size="md">{t("Formatting toolbar")}</Text>
        <Text size="sm" c="dimmed">
          {t(
            "Show a formatting toolbar above the editor with quick access to common actions.",
          )}
        </Text>
      </ResponsiveSettingsContent>

      <ResponsiveSettingsControl>
        <Switch
          labelPosition="left"
          defaultChecked={checked}
          onChange={handleChange}
          aria-label={t("Toggle formatting toolbar")}
        />
      </ResponsiveSettingsControl>
    </ResponsiveSettingsRow>
  );
}
