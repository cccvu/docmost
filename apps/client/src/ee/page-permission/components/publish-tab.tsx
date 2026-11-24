import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ActionIcon,
  Anchor,
  Button,
  Group,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import { IconExternalLink, IconLock } from "@tabler/icons-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { getPageIcon } from "@/lib";
import CopyTextButton from "@/components/common/copy";
import { getAppUrl, isCloud } from "@/lib/config";
import { buildPageUrl } from "@/features/page/page.utils";
import {
  useCreateShareMutation,
  useDeleteShareMutation,
  useShareForPageQuery,
  useUpdateShareMutation,
} from "@/features/share/queries/share-query";
import useTrial from "@/ee/hooks/use-trial";
import { sharePublishRefusal } from "@/features/share-lifecycle/share-publish-refusal";

type PublishTabProps = {
  pageId: string;
  readOnly?: boolean;
  isRestricted?: boolean;
  workspaceSharingDisabled?: boolean;
  spaceSharingDisabled?: boolean;
};

export function PublishTab({ pageId, readOnly, isRestricted, workspaceSharingDisabled, spaceSharingDisabled }: PublishTabProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pageSlug, spaceSlug } = useParams();
  const { isTrial } = useTrial();

  const { data: share } = useShareForPageQuery(pageId);
  const createShareMutation = useCreateShareMutation();
  const updateShareMutation = useUpdateShareMutation();
  const deleteShareMutation = useDeleteShareMutation();

  const pageIsShared = share && share.level === 0;
  const isDescendantShared = share && share.level > 0;

  const publicLink = `${getAppUrl()}/share/${share?.key}/p/${pageSlug}`;

  const [isPagePublic, setIsPagePublic] = useState<boolean>(false);

  useEffect(() => {
    setIsPagePublic(!!share);
  }, [share, pageId]);

  // CCC #858: the server's reason after a `share_not_permitted` refusal (the role may edit, not publish). For
  // the rest of this modal session the publish controls stay disabled and say why (the unpublish stays open).
  const [refusal, setRefusal] = useState<{ pageId: string; message: string }>();
  const publishRefusal = refusal?.pageId === pageId ? refusal.message : null;
  const refusalId = useId();
  const refusalRef = useRef<HTMLParagraphElement>(null);
  const focusRefusal = useRef(false);
  const noteRefusal = (err: unknown) => {
    const message = sharePublishRefusal(err);
    if (!message) return;
    focusRefusal.current = true;
    setRefusal({ pageId, message });
  };
  // CCC #913: the refusal disables the switch the user just pressed, which then cannot keep focus. Hand it to
  // the reason (tabIndex -1), unless focus already moved on to something usable.
  useEffect(() => {
    if (!publishRefusal || !focusRefusal.current) return;
    focusRefusal.current = false;
    const active = document.activeElement as HTMLInputElement | null;
    if (!active || active === document.body || active.disabled) {
      refusalRef.current?.focus();
    }
  }, [publishRefusal]);

  // CCC #858: optimistic, and rolled back when the server refuses (the mutation shows the server's message).
  const handleChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.currentTarget.checked;
    setIsPagePublic(value);

    try {
      if (value) {
        await createShareMutation.mutateAsync({
          pageId: pageId,
          includeSubPages: true,
          searchIndexing: false,
        });
      } else if (share && share.id) {
        await deleteShareMutation.mutateAsync(share.id);
      }
    } catch (err) {
      setIsPagePublic(!value);
      noteRefusal(err);
    }
  };

  // CCC #858: awaited, so a refusal is handled; the switches follow `share`, so they revert on their own.
  const handleSubPagesChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const value = event.currentTarget.checked;
    try {
      await updateShareMutation.mutateAsync({
        shareId: share.id,
        includeSubPages: value,
      });
    } catch (err) {
      noteRefusal(err);
    }
  };

  const handleIndexSearchChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const value = event.currentTarget.checked;
    try {
      await updateShareMutation.mutateAsync({
        shareId: share.id,
        searchIndexing: value,
      });
    } catch (err) {
      noteRefusal(err);
    }
  };

  const refusalProps = publishRefusal
    ? { "aria-describedby": refusalId }
    : {};

  const shareLink = useMemo(
    () => (
      <Group my="sm" gap={4} wrap="nowrap">
        <TextInput
          variant="filled"
          value={publicLink}
          readOnly
          rightSection={<CopyTextButton text={publicLink} />}
          style={{ width: "100%" }}
        />
        <ActionIcon
          component="a"
          variant="default"
          target="_blank"
          href={publicLink}
          size="sm"
        >
          <IconExternalLink size={16} />
        </ActionIcon>
      </Group>
    ),
    [publicLink],
  );

  if (isCloud() && isTrial) {
    return (
      <Stack align="center" py="md">
        <IconLock size={20} stroke={1.5} />
        <Text size="sm" ta="center" fw={500}>
          {t("Upgrade to share pages")}
        </Text>
        <Text size="sm" c="dimmed" ta="center">
          {t(
            "Page sharing is available on paid plans. Upgrade to share your pages publicly.",
          )}
        </Text>
        <Button size="xs" onClick={() => navigate("/settings/billing")}>
          {t("Upgrade Plan")}
        </Button>
      </Stack>
    );
  }

  if (workspaceSharingDisabled || spaceSharingDisabled) {
    return (
      <Stack align="center" py="md">
        <IconLock size={20} stroke={1.5} />
        <Text size="sm" ta="center" fw={500}>
          {t("Public sharing is disabled")}
        </Text>
        <Text size="sm" c="dimmed" ta="center">
          {workspaceSharingDisabled
            ? t("Public sharing has been disabled at the workspace level.")
            : t("Public sharing has been disabled for this space.")}
        </Text>
      </Stack>
    );
  }

  if (isRestricted) {
    return (
      <Stack align="center" py="md">
        <IconLock size={20} stroke={1.5} />
        <Text size="sm" ta="center" fw={500}>
          {t("Restricted page")}
        </Text>
        <Text size="sm" c="dimmed" ta="center">
          {t("Restricted pages cannot be shared publicly.")}
        </Text>
      </Stack>
    );
  }

  if (isDescendantShared) {
    return (
      <Stack gap="sm">
        <Text size="sm">{t("Inherits public sharing from")}</Text>
        <Anchor
          size="sm"
          underline="never"
          style={{
            cursor: "pointer",
            color: "var(--mantine-color-text)",
          }}
          component={Link}
          to={buildPageUrl(
            spaceSlug,
            share.sharedPage.slugId,
            share.sharedPage.title,
          )}
        >
          <Group gap="4" wrap="nowrap">
            {getPageIcon(share.sharedPage.icon)}
            <Text fz="sm" fw={500} lineClamp={1}>
              {share.sharedPage.title || t("untitled")}
            </Text>
          </Group>
        </Anchor>
        {shareLink}
      </Stack>
    );
  }

  return (
    <Stack gap="sm">
      <Group justify="space-between" wrap="nowrap" gap="xl">
        <div>
          <Text size="sm">
            {isPagePublic ? t("Shared to web") : t("Share to web")}
          </Text>
          <Text size="xs" c="dimmed">
            {isPagePublic
              ? t("Anyone with the link can view this page")
              : t("Make this page publicly accessible")}
          </Text>
        </div>
        <Switch
          onChange={handleChange}
          checked={isPagePublic}
          disabled={readOnly || (!!publishRefusal && !isPagePublic)}
          size="xs"
          aria-label={isPagePublic ? t("Shared to web") : t("Share to web")}
          {...refusalProps}
        />
      </Group>

      {publishRefusal && (
        <Text id={refusalId} ref={refusalRef} tabIndex={-1} size="xs" c="dimmed">
          {publishRefusal}
        </Text>
      )}

      {pageIsShared && (
        <>
          {shareLink}
          <Group justify="space-between" wrap="nowrap" gap="xl">
            <div>
              <Text size="sm">{t("Include sub-pages")}</Text>
              <Text size="xs" c="dimmed">
                {t("Make sub-pages public too")}
              </Text>
            </div>
            <Switch
              onChange={handleSubPagesChange}
              checked={share.includeSubPages}
              size="xs"
              disabled={readOnly || !!publishRefusal}
              aria-label={t("Include sub-pages")}
              {...refusalProps}
            />
          </Group>
          <Group justify="space-between" wrap="nowrap" gap="xl">
            <div>
              <Text size="sm">{t("Search engine indexing")}</Text>
              <Text size="xs" c="dimmed">
                {t("Allow search engines to index page")}
              </Text>
            </div>
            <Switch
              onChange={handleIndexSearchChange}
              checked={share.searchIndexing}
              size="xs"
              disabled={readOnly || !!publishRefusal}
              aria-label={t("Search engine indexing")}
              {...refusalProps}
            />
          </Group>
        </>
      )}
    </Stack>
  );
}
