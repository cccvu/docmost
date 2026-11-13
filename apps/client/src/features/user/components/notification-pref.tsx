import { userAtom } from "@/features/user/atoms/current-user-atom.ts";
import { updateUser } from "@/features/user/services/user-service.ts";
import { IUser, IUserSettings } from "@/features/user/types/user.types.ts";
import { Switch, Text, Title, Stack } from "@mantine/core";
import { useAtom } from "jotai";
import React, { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ResponsiveSettingsRow,
  ResponsiveSettingsContent,
  ResponsiveSettingsControl,
} from "@/components/ui/responsive-settings-row";
// CCC (wiki-v2 UI cleanup): remote mode keeps only the toggle that is not email-only.
import { isNativeAuthEnabled } from "@/features/auth-native/lib/auth-mode.ts";

type NotificationKey = keyof NonNullable<IUserSettings["notifications"]>;

const notificationItems: {
  key: NotificationKey;
  dtoField: keyof IUser;
  label: string;
  description: string;
}[] = [
  {
    key: "page.updated",
    dtoField: "notificationPageUpdates",
    label: "Page updates",
    description: "Get notified when pages you watch are updated.",
  },
  {
    key: "page.userMention",
    dtoField: "notificationPageUserMention",
    label: "Page mentions",
    description: "Get notified when someone mentions you on a page.",
  },
  {
    key: "comment.userMention",
    dtoField: "notificationCommentUserMention",
    label: "Comment mentions",
    description: "Get notified when someone mentions you in a comment.",
  },
  {
    key: "comment.created",
    dtoField: "notificationCommentCreated",
    label: "New comments",
    description:
      "Get notified about new comments on threads you participate in.",
  },
  {
    key: "comment.resolved",
    dtoField: "notificationCommentResolved",
    label: "Resolved comments",
    description: "Get notified when your comment is resolved.",
  },
];

function NotificationToggle({
  settingKey,
  dtoField,
  label,
  description,
}: {
  settingKey: NotificationKey;
  dtoField: keyof IUser;
  label: string;
  description: string;
}) {
  const { t } = useTranslation();
  const switchId = useId();
  const descriptionId = useId();
  const [user, setUser] = useAtom(userAtom);
  const [checked, setChecked] = useState(
    user.settings?.notifications?.[settingKey] !== false,
  );

  const handleChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.currentTarget.checked;
    setChecked(value);
    try {
      const updatedUser = await updateUser({ [dtoField]: value } as any);
      setUser(updatedUser);
    } catch {
      setChecked(!value);
    }
  };

  return (
    <ResponsiveSettingsRow>
      <ResponsiveSettingsContent>
        <Text component="label" htmlFor={switchId} size="md" style={{ cursor: "pointer" }}>
          {t(label)}
        </Text>
        <Text id={descriptionId} size="sm" c="dimmed">
          {t(description)}
        </Text>
      </ResponsiveSettingsContent>

      <ResponsiveSettingsControl>
        <Switch
          id={switchId}
          checked={checked}
          onChange={handleChange}
          aria-describedby={descriptionId}
        />
      </ResponsiveSettingsControl>
    </ResponsiveSettingsRow>
  );
}

export default function NotificationPref() {
  const { t } = useTranslation();
  // CCC (wiki-v2 UI cleanup): Docmost sends no mail in remote mode (no MAIL_DRIVER, so its no-op `log`
  // driver), so the four email-only toggles do nothing there. "Page updates" also gates the in-app
  // page-update notification (server page.notification.ts filters recipients on it before creating one).
  const native = isNativeAuthEnabled();
  const items = native
    ? notificationItems
    : notificationItems.filter((item) => item.key === "page.updated");

  return (
    <Stack gap="xs">
      <Title order={2} size="h5">
        {native ? t("Email notifications") : t("Notifications")}
      </Title>

      {items.map((item) => (
        <NotificationToggle
          key={item.key}
          settingKey={item.key}
          dtoField={item.dtoField}
          label={item.label}
          description={item.description}
        />
      ))}
    </Stack>
  );
}
