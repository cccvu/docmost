import classes from "@/features/editor/styles/editor.module.css";
import React, { useEffect } from "react";
import { TitleEditor } from "@/features/editor/title-editor";
import PageEditor from "@/features/editor/page-editor";
import {
  ActionIcon,
  Container,
  Divider,
  Group,
  Popover,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { IconInfoCircle } from "@tabler/icons-react";
import { useAtom } from "jotai";
import {
  userAtom,
  workspaceAtom,
} from "@/features/user/atoms/current-user-atom.ts";
import { CustomAvatar } from "@/components/ui/custom-avatar.tsx";
import { PageVerificationBadge } from "@/ee/page-verification";
import { useTranslation } from "react-i18next";
import { IContributor } from "@/features/page/types/page.types.ts";
import { FixedToolbar } from "@/features/editor/components/fixed-toolbar/fixed-toolbar";
import { PageEditMode } from "@/features/user/types/user.types.ts";
import { useAsideTriggerProps } from "@/hooks/use-toggle-aside.tsx";
import { DeletedPageBanner } from "@/features/page/trash/components/deleted-page-banner.tsx";
import clsx from "clsx";
import { currentPageEditModeAtom } from "@/features/editor/atoms/editor-atoms.ts";
import { resolvePageEditMode } from "@/features/editor/resolve-page-edit-mode.ts";
import { EmptyPageGetStarted } from "@/features/editor/components/empty-page/empty-page-get-started";
import { resolveEditorToolbarPref } from "@/features/editor-ux/prefs/editor-toolbar-pref";
import { formatCentralDateTime } from "@/features/editor-ux/format-central-datetime";

const MemoizedTitleEditor = React.memo(TitleEditor);
const MemoizedPageEditor = React.memo(PageEditor);
const MemoizedFixedToolbar = React.memo(FixedToolbar);
const MemoizedDeletedPageBanner = React.memo(DeletedPageBanner);

type PageUser = {
  id: string;
  name: string;
  avatarUrl: string;
};

// Module-level flag: survives component unmount/remount on page navigation,
// reset only on full page reload (i.e. a new app session).
let defaultEditModeApplied = false;

export interface FullEditorProps {
  pageId: string;
  slugId: string;
  title: string;
  content: string;
  spaceSlug: string;
  editable: boolean;
  creator?: PageUser;
  contributors?: IContributor[];
  // CCC: the byline surfaces the last editor + when, falling back to the creator.
  lastUpdatedBy?: PageUser;
  updatedAt?: Date;
  canComment?: boolean;
}

export function FullEditor({
  pageId,
  title,
  slugId,
  content,
  spaceSlug,
  editable,
  creator,
  contributors,
  lastUpdatedBy,
  updatedAt,
  canComment,
}: FullEditorProps) {
  const [user] = useAtom(userAtom);
  const [workspace] = useAtom(workspaceAtom);
  const fullPageWidth = user.settings?.preferences?.fullPageWidth;
  // CCC (issue #135): formatting toolbar defaults ON; explicit opt-out honored.
  const editorToolbarEnabled = resolveEditorToolbarPref(user);
  const [currentPageEditMode, setCurrentPageEditMode] = useAtom(
    currentPageEditModeAtom,
  );
  // CCC: page open-mode precedence — explicit user preference > workspace default
  // > Read system fallback (resolvePageEditMode, unit-tested). Pages open in READ by
  // default (prevent accidental edits); the admin's workspace default (set in the
  // console) is the shared knob, and an explicit per-user Edit choice still wins.
  const userPageEditMode = resolvePageEditMode(
    user.settings?.preferences?.pageEditMode,
    workspace?.settings?.defaultPageEditMode,
  );
  const isEditMode = currentPageEditMode === PageEditMode.Edit;

  // Apply the user's saved preference only once on initial load, not on every
  // page navigation — so the mode sticks across navigations within a session.
  useEffect(() => {
    if (!defaultEditModeApplied) {
      setCurrentPageEditMode(userPageEditMode as PageEditMode);
      defaultEditModeApplied = true;
    }
  }, [userPageEditMode, setCurrentPageEditMode]);

  return (
    <Container
      fluid={fullPageWidth}
      size={!fullPageWidth && 900}
      className={classes.editor}
      style={{ display: "flex", flexDirection: "column" }}
    >
      {editorToolbarEnabled && editable && isEditMode && (
        <MemoizedFixedToolbar />
      )}
      <MemoizedDeletedPageBanner slugId={slugId} />
      <MemoizedTitleEditor
        pageId={pageId}
        slugId={slugId}
        title={title}
        spaceSlug={spaceSlug}
        editable={editable}
      />
      <PageByline
        creator={creator}
        contributors={contributors}
        lastUpdatedBy={lastUpdatedBy}
        updatedAt={updatedAt}
        readOnly={!editable}
      />
      <MemoizedPageEditor
        pageId={pageId}
        editable={editable}
        content={content}
        canComment={canComment}
      />
      <EmptyPageGetStarted pageId={pageId} editable={editable} />
    </Container>
  );
}

type PageBylineProps = {
  creator?: PageUser;
  contributors?: IContributor[];
  lastUpdatedBy?: PageUser;
  updatedAt?: Date;
  readOnly?: boolean;
};

// Exported for the fork-owned byline test (features/editor-ux/page-byline.test.tsx).
export function PageByline({
  creator,
  contributors,
  lastUpdatedBy,
  updatedAt,
  readOnly,
}: PageBylineProps) {
  const { t } = useTranslation();
  const detailsTriggerProps = useAsideTriggerProps("details");

  // CCC: the byline reports the last editor (who touched the page most
  // recently) and when, falling back to the creator for a never-edited page.
  const editor = lastUpdatedBy ?? creator;
  const updatedAtLabel = updatedAt ? formatCentralDateTime(updatedAt) : "";
  // One source for BOTH the visible byline and the trigger's accessible name,
  // so the accessible name always carries the timestamp too (WCAG 2.5.3
  // Label-in-Name: the accessible name must contain the visible text).
  const bylineLabel = editor
    ? updatedAtLabel
      ? `${t("Updated by {{name}}", { name: editor.name })} · ${updatedAtLabel}`
      : t("Updated by {{name}}", { name: editor.name })
    : "";

  // The popover already names the creator (Owner) and the last editor (header
  // row), so drop both from the Contributors list to avoid repeating a person.
  const otherContributors = (contributors ?? []).filter(
    (c) => c.id !== creator?.id && c.id !== editor?.id,
  );

  return (
    <Group
      gap="sm"
      mb="md"
      className={clsx("print-hide", classes.byline)}
      style={{ marginTop: "-0.5em" }}
    >
      {editor && (
        <Popover position="bottom-start" shadow="md" width={280} withArrow>
          <Popover.Target>
            <UnstyledButton aria-label={bylineLabel}>
              <Group gap={6}>
                <CustomAvatar
                  avatarUrl={editor.avatarUrl}
                  name={editor.name}
                  size={22}
                />
                <Text size="sm" c="dimmed">
                  {bylineLabel}
                </Text>
              </Group>
            </UnstyledButton>
          </Popover.Target>
          <Popover.Dropdown>
            <Stack gap="xs">
              {/* The person the byline names: the last editor + when. */}
              <Group gap="sm">
                <CustomAvatar
                  avatarUrl={editor.avatarUrl}
                  name={editor.name}
                  size={36}
                />
                <div>
                  <Text size="sm" fw={500}>
                    {editor.name}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {updatedAtLabel
                      ? `${t("Last updated")} · ${updatedAtLabel}`
                      : t("Last updated")}
                  </Text>
                </div>
              </Group>

              {/* The creator (Owner), only when they aren't the last editor. */}
              {creator && creator.id !== editor.id && (
                <>
                  <Divider />
                  <Group gap="sm">
                    <CustomAvatar
                      avatarUrl={creator.avatarUrl}
                      name={creator.name}
                      size={28}
                    />
                    <div>
                      <Text size="sm">{creator.name}</Text>
                      <Text size="xs" c="dimmed">
                        {t("Owner")}
                      </Text>
                    </div>
                  </Group>
                </>
              )}

              {otherContributors.length > 0 && (
                <>
                  <Divider />
                  <Text size="xs" fw={500} c="dimmed" tt="uppercase">
                    {t("Contributors")}
                  </Text>
                  <Stack gap={6}>
                    {otherContributors.map((contributor) => (
                      <Group gap="sm" key={contributor.id}>
                        <CustomAvatar
                          avatarUrl={contributor.avatarUrl}
                          name={contributor.name}
                          size={28}
                        />
                        <Text size="sm">{contributor.name}</Text>
                      </Group>
                    ))}
                  </Stack>
                </>
              )}
            </Stack>
          </Popover.Dropdown>
        </Popover>
      )}
      <Tooltip label={t("Details")} withArrow openDelay={250}>
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label={t("Details")}
          {...detailsTriggerProps}
        >
          <IconInfoCircle size={20} stroke={1.5} />
        </ActionIcon>
      </Tooltip>

      <PageVerificationBadge readOnly={readOnly} />
    </Group>
  );
}
