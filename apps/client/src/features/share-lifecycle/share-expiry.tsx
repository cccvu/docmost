// CCC (fork-owned): the "Link expires" control in the page share modal's Publish tab (#335, ADR 0032).
//
// Remote mode only. It renders for a page that is shared DIRECTLY (share level 0), is not restricted, and
// whose workspace and space allow sharing: the same states in which `PublishTab` shows its share controls.
// An inherited share (level > 0) belongs to the ancestor's modal. All of this is UX gating; the server
// re-checks `edit` on every change and enforces expiry on every public read.
//
// The Select is an action picker: choosing a duration sets the expiry to now + that duration, so choosing
// the same duration again renews the link. It therefore shows no selected duration (only "Never", which
// is a state, not a countdown), and every duration choice fires a change.
import { useEffect } from "react";
import { Group, Select, Stack, Text } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { isNativeAuthEnabled } from "@/features/auth-native/lib/auth-mode.ts";
import { useShareForPageQuery } from "@/features/share/queries/share-query";
import {
  errorStatus,
  useSetShareExpiryMutation,
  useShareExpiryQuery,
} from "./share-expiry-query";
import { ShareExpiryDays } from "./share-expiry-service";

export type ShareExpiryProps = {
  pageId: string | undefined;
  readOnly?: boolean;
  isRestricted?: boolean;
  workspaceSharingDisabled?: boolean;
  spaceSharingDisabled?: boolean;
};

const NEVER = "never";

function toDays(value: string): ShareExpiryDays | undefined {
  if (value === NEVER) return null;
  const n = Number(value);
  return n === 7 || n === 30 || n === 90 || n === 365 ? n : undefined;
}

export function ShareExpiry({
  pageId,
  readOnly,
  isRestricted,
  workspaceSharingDisabled,
  spaceSharingDisabled,
}: ShareExpiryProps) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const remote = !isNativeAuthEnabled();

  const { data: share } = useShareForPageQuery(remote ? pageId : undefined);
  const eligible =
    remote &&
    !isRestricted &&
    !workspaceSharingDisabled &&
    !spaceSharingDisabled &&
    !!share?.id &&
    share.level === 0;

  const expiryQuery = useShareExpiryQuery(eligible ? share.id : undefined);
  const setExpiry = useSetShareExpiryMutation();
  const notFound = expiryQuery.isError && errorStatus(expiryQuery.error) === 404;

  // A 404 means the share is no longer live (expired, or unpublished elsewhere): let the Publish tab
  // re-read the page's share state instead of offering a dead link.
  useEffect(() => {
    if (notFound) {
      queryClient.invalidateQueries({ queryKey: ["share-for-page"] });
    }
  }, [notFound, queryClient]);

  if (!eligible || notFound || expiryQuery.isPending) return null;

  if (expiryQuery.isError) {
    return (
      <Text size="xs" c="dimmed" mt="sm">
        {t("Couldn't load the link expiry.")}
      </Text>
    );
  }

  const expiresAt = expiryQuery.data?.expiresAt ?? null;
  const formatted = expiresAt
    ? new Date(expiresAt).toLocaleDateString(i18n.language, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "";

  const options = [
    { value: "7", label: t("7 days") },
    { value: "30", label: t("30 days") },
    { value: "90", label: t("90 days") },
    { value: "365", label: t("1 year") },
    { value: NEVER, label: t("Never") },
  ];

  const handleChange = (value: string | null) => {
    if (value == null) return;
    const expiresInDays = toDays(value);
    if (expiresInDays === undefined) return;
    setExpiry.mutate({ shareId: share.id, expiresInDays });
  };

  return (
    <Stack gap={4} mt="sm">
      <Group justify="space-between" wrap="nowrap" gap="xl">
        <div>
          <Text size="sm">{t("Link expires")}</Text>
          <Text size="xs" c="dimmed" data-testid="share-expiry-state">
            {expiresAt
              ? t("Expires on {{date}}", { date: formatted })
              : t("Never expires")}
          </Text>
          {!readOnly && (
            <Text size="xs" c="dimmed">
              {t("Durations are counted from today.")}
            </Text>
          )}
        </div>
        <Select
          size="xs"
          w={130}
          aria-label={t("Link expires")}
          data={options}
          value={expiresAt === null ? NEVER : null}
          placeholder={t("Change")}
          allowDeselect={false}
          checkIconPosition="right"
          disabled={readOnly || setExpiry.isPending}
          onChange={handleChange}
        />
      </Group>
    </Stack>
  );
}
