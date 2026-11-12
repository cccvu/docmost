import { useEffect, useRef, useState } from "react";
import { Alert, Button, Group, Modal, Stack, Text } from "@mantine/core";
import {
  IconAlertTriangle,
  IconHourglass,
  IconInfoCircle,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { CollabAccessState, CollabRefusalKind } from "./collab-access";
import { CollabEpochControl } from "./collab-epoch";
import { collabRefusalCause, type CollabRefusalCause } from "./collab-refusal-cause";

/**
 * CCC fork addition (cccvu/wiki-v2#781) — shown once the server refused a collab frame from this editor
 * (`collab-access.ts`, `refused`). The provider is already detached and the editor read-only, so nothing more is sent,
 * and nothing more arrives: every body says other people's edits no longer appear here.
 *
 *   - Reload (primary): a fresh Yjs clientID, keeping this browser's copy. Recovers a rolling-deploy skew. Not a
 *     clientID the server bound to someone else: the copy holds the refused edit under that ID and replays it.
 *   - Discard this browser's copy: after a confirm, clear the page's IndexedDB copy, then reload. For a copy the
 *     server refuses every time it is replayed. A failed clear does not reload (it would replay the same copy).
 *   - #810: after a 1009 (`too-big`: this browser sent a frame over the server's size limit) the oversized change is
 *     in this browser's copy, which a reload replays, so the notice says so, leads with Discard and offers no Reload.
 *   - #827: the other Discard-first kinds (`collab-access.ts`, `refusalKind`): `too-big` also for a frame over the
 *     page's size cap, `too-complex` (a change the server twice ran out of time applying), `page-full` (the page is at
 *     its size limit), and `compacted` (the page was rebuilt under a new epoch while this copy held unsaved changes:
 *     its Discard opens the current version, `reload` being the epoch switch, so nothing of the old copy merges).
 *
 * The ledger-echo incident (#781 lineage): one red "Your latest changes were not saved" for every rule told a writer
 * who had typed nothing that their work was lost. A `generic` refusal's copy now follows the rule's cause
 * (`collab-refusal-cause.ts`): only `change` says a change was not saved, in red; `copy` and `other` say editing is
 * paused, in blue (yellow's light-alert title fails WCAG 1.4.3 contrast). Every Discard-first kind is about a change
 * this browser holds, so it is red. Every cause keeps Reload and Discard.
 *
 *   - `passive` (Read mode, or no edit permission: the editor was never editable under the cursor): role="status" and
 *     no focus move, the same text. Switching to Edit makes it an alert and focuses it once; switching back never
 *     moves focus.
 *   - `showsLocalCopy` false (the page still shows the server's saved version: the refusal came before the first sync,
 *     so this browser's copy was never rendered): the Discard confirm cannot ask the user to copy what they need from
 *     the page, so it says unsent changes are not shown and cannot be recovered after discarding.
 *
 * Wired by page-editor.tsx (seam 169) through `CollabPageNotices`.
 */
export interface CollabRefusalNoticeProps {
  /** Clear this page's local (IndexedDB) copy: `clearLocalCollabCopy`. */
  clearLocalCopy: () => Promise<void>;
  /** After a successful Discard (default: reload the page; `compacted`: open the current version). */
  reload?: () => void;
  /** #810, #827: which refusal (`refusalKind`); every kind but `generic` is Discard-first. */
  kind?: CollabRefusalKind;
  /** A `generic` refusal's copy (`collabRefusalCause(refusedRule)`); the generic one by default. */
  cause?: CollabRefusalCause;
  /** Read mode or no edit permission: an advisory status that does not take focus. */
  passive?: boolean;
  /** The page shows this browser's own copy (false: still the server's saved version). */
  showsLocalCopy?: boolean;
}

export function CollabRefusalNotice({
  clearLocalCopy,
  reload = () => window.location.reload(),
  kind = "generic",
  cause = "other",
  passive = false,
  showsLocalCopy = true,
}: CollabRefusalNoticeProps) {
  const { t } = useTranslation();
  const alertRef = useRef<HTMLDivElement>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [clearFailed, setClearFailed] = useState(false);

  // The editor just became read-only under the user's cursor: bring them to the explanation. Keyed on `passive` alone,
  // so focus moves on mount and on a switch to Edit (passive → false), and never when the user switches back to Read.
  useEffect(() => {
    if (!passive) alertRef.current?.focus();
  }, [passive]);

  const discardFirst = kind !== "generic";
  const notSaved = discardFirst || cause === "change";

  const discard = async () => {
    setDiscarding(true);
    setClearFailed(false);
    try {
      await clearLocalCopy();
    } catch {
      setClearFailed(true);
      setDiscarding(false);
      return;
    }
    reload();
  };

  return (
    <>
      <Alert
        ref={alertRef}
        tabIndex={-1}
        role={passive ? "status" : "alert"}
        variant="light"
        color={notSaved ? "red" : "blue"}
        icon={
          notSaved ? (
            <IconAlertTriangle aria-hidden />
          ) : (
            <IconInfoCircle aria-hidden />
          )
        }
        title={
          notSaved
            ? t("A change from this browser was not saved")
            : t("Editing is paused on this page")
        }
        mb="md"
      >
        <Stack gap="sm">
          <Text size="sm">{refusalText(kind, cause, t)}</Text>
          <Group gap="sm">
            {!discardFirst && (
              <Button size="xs" onClick={() => reload()}>
                {t("Reload")}
              </Button>
            )}
            <Button
              size="xs"
              variant={discardFirst ? "filled" : "default"}
              color="red"
              onClick={() => setConfirmOpen(true)}
            >
              {kind === "compacted"
                ? t("Open the current version")
                : t("Discard this browser's copy")}
            </Button>
          </Group>
        </Stack>
      </Alert>
      <Modal
        opened={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={t("Discard this browser's copy?")}
        centered
      >
        <Stack gap="sm">
          <Text size="sm">
            {showsLocalCopy
              ? t(
                  "Any changes in this browser that the server has not received will be lost. Before you continue, copy anything you need from the page.",
                )
              : t(
                  "Any changes in this browser that the server has not received will be lost. This page shows the last version the server saved, so those changes are not shown here and cannot be recovered after you discard them.",
                )}
          </Text>
          <Text size="sm">
            {t(
              "Close any other tabs of this page first, or they may write their copy back.",
            )}
          </Text>
          {clearFailed && (
            <Text size="sm" c="red" role="alert">
              {t(
                "This browser's copy could not be cleared. Close the page's other tabs and try again.",
              )}
            </Text>
          )}
          <Group justify="flex-end" gap="sm">
            <Button
              variant="default"
              onClick={() => setConfirmOpen(false)}
              disabled={discarding}
            >
              {t("Cancel")}
            </Button>
            <Button color="red" onClick={discard} loading={discarding}>
              {kind === "compacted"
                ? t("Discard and open the current version")
                : t("Discard and reload")}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

function refusalText(
  kind: CollabRefusalKind,
  cause: CollabRefusalCause,
  t: (key: string) => string,
) {
  switch (kind) {
    case "too-big":
      return t(
        "A change in this browser is too large to send, so editing is paused and other people's edits no longer appear here. Reloading would send it again. To continue, discard this browser's copy of the page.",
      );
    case "too-complex":
      return t(
        "A change in this browser is too complex for the server to apply, so editing is paused and other people's edits no longer appear here. Reloading would send it again. To continue, discard this browser's copy of the page.",
      );
    case "page-full":
      return t(
        "This page is at its size limit, so the server could not accept a change from this browser, editing is paused and other people's edits no longer appear here. Reloading would send it again. To continue, discard this browser's copy of the page, and put new content on another page.",
      );
    case "compacted":
      return t(
        "The server optimized this page after this browser last saved it, so the changes made here since then cannot be merged. Copy anything you need from the page, then open the current version.",
      );
  }
  switch (cause) {
    case "change":
      return t(
        "The server did not accept a change from this browser, so editing is paused and other people's edits no longer appear here. Reload the page to continue. If that does not help, discard this browser's copy of the page.",
      );
    case "copy":
      return t(
        "This browser's stored copy of the page does not match the server, so editing is paused and other people's edits no longer appear here. Reload the page to continue. If that does not help, discard this browser's copy of the page.",
      );
    default:
      return t(
        "The server stopped syncing this page with this browser, so editing is paused and other people's edits no longer appear here. Reload the page to continue. If that does not help, discard this browser's copy of the page.",
      );
  }
}

/**
 * #827: everything the collab state shows above the editor, wired by page-editor.tsx (seam 169):
 *   - compacting: a read-only banner while the editor waits out the compaction (it retries on its own);
 *   - refused: the refusal notice of its kind, its copy following the refused rule's cause. An epoch change shows it
 *     only for a dirty copy (`compactedTo`); a clean copy is switching to the new epoch, so nothing is shown while
 *     that is decided.
 */
export function CollabPageNotices({
  access,
  epoch,
  clearLocalCopy,
  passive = false,
  showsLocalCopy = true,
}: {
  access: CollabAccessState;
  epoch: Pick<CollabEpochControl, "compactedTo" | "openCurrentVersion">;
  clearLocalCopy: () => Promise<void>;
  /** Read mode or no edit permission (`CollabRefusalNotice`). */
  passive?: boolean;
  /** The page shows this browser's own copy (`CollabRefusalNotice`). */
  showsLocalCopy?: boolean;
}) {
  const { t } = useTranslation();
  if (access.refused) {
    if (access.refusalKind !== "compacted") {
      return (
        <CollabRefusalNotice
          kind={access.refusalKind}
          cause={collabRefusalCause(access.refusedRule)}
          passive={passive}
          showsLocalCopy={showsLocalCopy}
          clearLocalCopy={clearLocalCopy}
        />
      );
    }
    if (epoch.compactedTo === null) return null;
    return (
      <CollabRefusalNotice
        kind="compacted"
        passive={passive}
        showsLocalCopy={showsLocalCopy}
        clearLocalCopy={clearLocalCopy}
        reload={epoch.openCurrentVersion}
      />
    );
  }
  if (!access.compacting) return null;
  return (
    <Alert
      variant="light"
      color="blue" // not yellow: its light-alert title fails WCAG 1.4.3 contrast (as for the refusal notice)
      icon={<IconHourglass aria-hidden />}
      title={t("This page is being optimized")}
      role="status"
      mb="md"
    >
      <Text size="sm">
        {t(
          "Editing is paused for a moment and resumes on its own. Nothing you already saved is lost.",
        )}
      </Text>
    </Alert>
  );
}
