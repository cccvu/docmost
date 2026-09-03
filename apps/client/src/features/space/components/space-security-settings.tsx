import { Divider, Title } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { ISpace } from "@/features/space/types/space.types.ts";
import SpacePublicSharingToggle from "@/ee/security/components/space-public-sharing-toggle.tsx";
import SpaceViewerCommentsToggle from "@/ee/security/components/space-viewer-comments-toggle.tsx";
import { useFeatureAvailable } from "@/features/feature-availability/feature-gate.tsx";
import { Feature } from "@/ee/features";

type SpaceSecuritySettingsProps = {
  space: ISpace;
  readOnly?: boolean;
};

export default function SpaceSecuritySettings({
  space,
  readOnly,
}: SpaceSecuritySettingsProps) {
  const { t } = useTranslation();
  // CCC: HIDE the paid toggles when unavailable (were rendered disabled with an
  // upgrade tooltip); render nothing if neither is available.
  const hasPublicSharing = useFeatureAvailable(Feature.SHARING_CONTROLS);
  const hasViewerComments = useFeatureAvailable(Feature.VIEWER_COMMENTS);

  if (readOnly) return null;
  if (!hasPublicSharing && !hasViewerComments) return null;

  return (
    <div>
      <Title order={3} my="md" size="h6" fw={600}>
        {t("Security")}
      </Title>

      {hasPublicSharing && <SpacePublicSharingToggle space={space} />}

      {hasPublicSharing && hasViewerComments && <Divider my="lg" />}

      {hasViewerComments && <SpaceViewerCommentsToggle space={space} />}
    </div>
  );
}
