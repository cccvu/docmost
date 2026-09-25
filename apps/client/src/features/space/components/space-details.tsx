import React, { useState } from "react";
import { useSpaceQuery } from "@/features/space/queries/space-query.ts";
import { EditSpaceForm } from "@/features/space/components/edit-space-form.tsx";
import { Anchor, Button, Divider, Text, Title } from "@mantine/core";
import DeleteSpaceModal from "./delete-space-modal";
import { useDisclosure } from "@mantine/hooks";
import ExportModal from "@/components/common/export-modal.tsx";
import AvatarUploader from "@/components/common/avatar-uploader.tsx";
import {
  uploadSpaceIcon,
  removeSpaceIcon,
} from "@/features/attachments/services/attachment-service.ts";
import { useTranslation } from "react-i18next";
import { AvatarIconType } from "@/features/attachments/types/attachment.types.ts";
import { queryClient } from "@/main.tsx";
import {
  ResponsiveSettingsContent,
  ResponsiveSettingsControl,
  ResponsiveSettingsRow,
} from "@/components/ui/responsive-settings-row.tsx";
import { isNativeAuthEnabled } from "@/features/auth-native/lib/auth-mode.ts";
import { usePlatformAdminContext } from "@/features/admin-entry/use-platform-admin-context.ts";


interface SpaceDetailsProps {
  spaceId: string;
  readOnly?: boolean;
}
export default function SpaceDetails({ spaceId, readOnly }: SpaceDetailsProps) {
  const { t } = useTranslation();
  const { data: space, isLoading, refetch } = useSpaceQuery(spaceId);
  const [exportOpened, { open: openExportModal, close: closeExportModal }] =
    useDisclosure(false);
  const [isIconUploading, setIsIconUploading] = useState(false);

  // CCC (#502): in remote (platform) mode the server refuses the native space hard delete
  // (404) — removal is archive-only (Admin Console, /v1, MCP) — so the Delete button
  // could only fail. Show an informational note instead, plus a console link for platform
  // workspace admins (the console is workspace-admin-only). Native/standalone mode keeps
  // the upstream Delete row. The admin-context query is the header's shared, cached one.
  const spaceDeleteArchiveOnly = !isNativeAuthEnabled();
  const platformAdminGate = usePlatformAdminContext();

  const handleIconUpload = async (file: File) => {
    setIsIconUploading(true);
    try {
      await uploadSpaceIcon(file, spaceId);
      await refetch();
      await queryClient.invalidateQueries({
        predicate: (item) => ["spaces"].includes(item.queryKey[0] as string),
      });
    } catch (err) {
      // skip
    } finally {
      setIsIconUploading(false);
    }
  };

  const handleIconRemove = async () => {
    setIsIconUploading(true);
    try {
      await removeSpaceIcon(spaceId);
      await refetch();
      await queryClient.invalidateQueries({
        predicate: (item) => ["spaces"].includes(item.queryKey[0] as string),
      });
    } catch (err) {
      // skip
    } finally {
      setIsIconUploading(false);
    }
  };

  return (
    <>
      {space && (
        <div>
          <Title order={3} my="md" size="h6" fw={600}>
            {t("Details")}
          </Title>

          <div style={{ marginBottom: "20px" }}>
            <Text size="sm" fw={500} mb="xs">
              {t("Icon")}
            </Text>
            <AvatarUploader
              currentImageUrl={space.logo}
              fallbackName={space.name}
              size={"60px"}
              variant="filled"
              type={AvatarIconType.SPACE_ICON}
              onUpload={handleIconUpload}
              onRemove={handleIconRemove}
              isLoading={isIconUploading}
              disabled={readOnly}
            />
          </div>

          <EditSpaceForm space={space} readOnly={readOnly} />

          {!readOnly && (
            <>
              <Divider my="lg" />

              <ResponsiveSettingsRow>
                <ResponsiveSettingsContent>
                  <Text size="md">{t("Export space")}</Text>
                  <Text size="sm" c="dimmed">
                    {t("Export all pages and attachments in this space.")}
                  </Text>
                </ResponsiveSettingsContent>
                <ResponsiveSettingsControl>
                  <Button onClick={openExportModal}>{t("Export")}</Button>
                </ResponsiveSettingsControl>
              </ResponsiveSettingsRow>

              <Divider my="lg" />

              <ResponsiveSettingsRow>
                <ResponsiveSettingsContent>
                  <Text size="md">{t("Delete space")}</Text>
                  <Text size="sm" c="dimmed">
                    {spaceDeleteArchiveOnly
                      ? t(
                          "Spaces can't be permanently deleted here. A workspace admin can archive this space instead; archived spaces can be restored.",
                        )
                      : t("Delete this space with all its pages and data.")}
                  </Text>
                </ResponsiveSettingsContent>
                {!spaceDeleteArchiveOnly ? (
                  <ResponsiveSettingsControl>
                    <DeleteSpaceModal space={space} />
                  </ResponsiveSettingsControl>
                ) : (
                  platformAdminGate === "admin" && (
                    <ResponsiveSettingsControl>
                      <Anchor
                        href="/console"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {t("Open the Admin Console")}
                      </Anchor>
                    </ResponsiveSettingsControl>
                  )
                )}
              </ResponsiveSettingsRow>

              <ExportModal
                type="space"
                id={space.id}
                open={exportOpened}
                onClose={closeExportModal}
              />
            </>
          )}
        </div>
      )}
    </>
  );
}
