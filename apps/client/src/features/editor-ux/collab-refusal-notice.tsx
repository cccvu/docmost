import { useEffect, useRef, useState } from "react";
import { Alert, Button, Group, Modal, Stack, Text } from "@mantine/core";
import { IconAlertTriangle, IconHourglass } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { CollabAccessState, CollabRefusalKind } from "./collab-access";
import { CollabEpochControl } from "./collab-epoch";

/**
 * CCC fork addition (cccvu/wiki-v2#781) — shown once the server refused a collab frame from this editor
 * (`collab-access.ts`, `refused`). The provider is already detached and the editor read-only, so nothing more is sent.
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
 * Wired by page-editor.tsx (seam 169) through `CollabPageNotices`.
 */
export interface CollabRefusalNoticeProps {
  /** Clear this page's local (IndexedDB) copy: `clearLocalCollabCopy`. */
  clearLocalCopy: () => Promise<void>;
  /** After a successful Discard (default: reload the page; `compacted`: open the current version). */
  reload?: () => void;
  /** #810, #827: which refusal (`refusalKind`); every kind but `generic` is Discard-first. */
  kind?: CollabRefusalKind;
}

export function CollabRefusalNotice({
  clearLocalCopy,
  reload = () => window.location.reload(),
  kind = "generic",
}: CollabRefusalNoticeProps) {
  const { t } = useTranslation();
  const alertRef = useRef<HTMLDivElement>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [clearFailed, setClearFailed] = useState(false);

  // The editor just became read-only under the user's cursor: bring them to the explanation.
  useEffect(() => {
    alertRef.current?.focus();
  }, []);

  const discardFirst = kind !== "generic";

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
        variant="light"
        color="red"
        icon={<IconAlertTriangle aria-hidden />}
        title={t("Your latest changes were not saved")}
        mb="md"
      >
        <Stack gap="sm">
          <Text size="sm">{refusalText(kind, t)}</Text>
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
            {t(
              "Changes in this browser that the server has not saved will be lost. Before you continue, copy anything you need from the page.",
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

function refusalText(kind: CollabRefusalKind, t: (key: string) => string) {
  switch (kind) {
    case "too-big":
      return t(
        "A change in this browser is too large to send, so editing is paused. Reloading would send it again. To continue, discard this browser's copy of the page.",
      );
    case "too-complex":
      return t(
        "A change in this browser is too complex for the server to apply, so editing is paused. Reloading would send it again. To continue, discard this browser's copy of the page.",
      );
    case "page-full":
      return t(
        "This page is at its size limit, so the server could not accept a change from this browser and editing is paused. Reloading would send it again. To continue, discard this browser's copy of the page, and put new content on another page.",
      );
    case "compacted":
      return t(
        "The server optimized this page after this browser last saved it, so the changes made here since then cannot be merged. Copy anything you need from the page, then open the current version.",
      );
    default:
      return t(
        "The server could not accept a change from this browser, so editing is paused. Reload the page to continue. If that does not help, discard this browser's copy of the page.",
      );
  }
}

/**
 * #827: everything the collab state shows above the editor, wired by page-editor.tsx (seam 169):
 *   - compacting: a read-only banner while the editor waits out the compaction (it retries on its own);
 *   - refused: the refusal notice of its kind. An epoch change shows it only for a dirty copy (`compactedTo`); a
 *     clean copy is switching to the new epoch, so nothing is shown while that is decided.
 */
export function CollabPageNotices({
  access,
  epoch,
  clearLocalCopy,
}: {
  access: CollabAccessState;
  epoch: Pick<CollabEpochControl, "compactedTo" | "openCurrentVersion">;
  clearLocalCopy: () => Promise<void>;
}) {
  const { t } = useTranslation();
  if (access.refused) {
    if (access.refusalKind !== "compacted") {
      return (
        <CollabRefusalNotice
          kind={access.refusalKind}
          clearLocalCopy={clearLocalCopy}
        />
      );
    }
    if (epoch.compactedTo === null) return null;
    return (
      <CollabRefusalNotice
        kind="compacted"
        clearLocalCopy={clearLocalCopy}
        reload={epoch.openCurrentVersion}
      />
    );
  }
  if (!access.compacting) return null;
  return (
    <Alert
      variant="light"
      color="yellow"
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
