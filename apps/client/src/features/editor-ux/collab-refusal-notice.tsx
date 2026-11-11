import { useEffect, useRef, useState } from "react";
import { Alert, Button, Group, Modal, Stack, Text } from "@mantine/core";
import { IconAlertTriangle, IconInfoCircle } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { CollabRefusalCause } from "./collab-refusal-cause";

/**
 * CCC fork addition (cccvu/wiki-v2#781) — shown once the server refused a collab frame from this editor
 * (`collab-access.ts`, `refused`). The provider is already detached and the editor read-only, so nothing more is sent,
 * and nothing more arrives: every body says other people's edits no longer appear here.
 *
 *   - Reload (primary): a fresh Yjs clientID, keeping this browser's copy. Recovers a rolling-deploy skew. Not a
 *     clientID the server bound to someone else: the copy holds the refused edit under that ID and replays it.
 *   - Discard this browser's copy: after a confirm, clear the page's IndexedDB copy, then reload. For a copy the
 *     server refuses every time it is replayed. A failed clear does not reload (it would replay the same copy).
 *   - #810: after a 1009 (`tooBig`: this browser sent a frame over the server's size limit) the oversized change is
 *     in this browser's copy, which a reload replays, so the notice says so, leads with Discard and offers no Reload.
 *
 * The ledger-echo incident (#781 lineage): one red "Your latest changes were not saved" for every rule told a writer
 * who had typed nothing that their work was lost. The copy now follows the rule's cause (`collab-refusal-cause.ts`):
 * only `change` (and `tooBig`) says a change was not saved, in red; `copy` and `other` say editing is paused, in blue
 * (yellow's light-alert title fails WCAG 1.4.3 contrast). Every cause keeps Reload and Discard.
 *
 *   - `passive` (Read mode, or no edit permission: the editor was never editable under the cursor): role="status" and
 *     no focus move, the same text. Switching to Edit makes it an alert and focuses it once; switching back never
 *     moves focus.
 *   - `showsLocalCopy` false (the page still shows the server's saved version: the refusal came before the first sync,
 *     so this browser's copy was never rendered): the Discard confirm cannot ask the user to copy what they need from
 *     the page, so it says unsent changes are not shown and cannot be recovered after discarding.
 *
 * Wired by page-editor.tsx (seam 169).
 */
export interface CollabRefusalNoticeProps {
  /** Clear this page's local (IndexedDB) copy: `clearLocalCollabCopy`. */
  clearLocalCopy: () => Promise<void>;
  reload?: () => void;
  /** #810: the refusal was a 1009 (`refusedTooBig`): only discarding this browser's copy recovers. */
  tooBig?: boolean;
  /** Which copy to show (`collabRefusalCause(refusedRule)`); the generic one by default. */
  cause?: CollabRefusalCause;
  /** Read mode or no edit permission: an advisory status that does not take focus. */
  passive?: boolean;
  /** The page shows this browser's own copy (false: still the server's saved version). */
  showsLocalCopy?: boolean;
}

export function CollabRefusalNotice({
  clearLocalCopy,
  reload = () => window.location.reload(),
  tooBig = false,
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

  const notSaved = tooBig || cause === "change";
  let body: string;
  if (tooBig) {
    body = t(
      "A change in this browser is too large to send, so editing is paused and other people's edits no longer appear here. Reloading would send it again. To continue, discard this browser's copy of the page.",
    );
  } else if (cause === "change") {
    body = t(
      "The server did not accept a change from this browser, so editing is paused and other people's edits no longer appear here. Reload the page to continue. If that does not help, discard this browser's copy of the page.",
    );
  } else if (cause === "copy") {
    body = t(
      "This browser's stored copy of the page does not match the server, so editing is paused and other people's edits no longer appear here. Reload the page to continue. If that does not help, discard this browser's copy of the page.",
    );
  } else {
    body = t(
      "The server stopped syncing this page with this browser, so editing is paused and other people's edits no longer appear here. Reload the page to continue. If that does not help, discard this browser's copy of the page.",
    );
  }

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
          <Text size="sm">{body}</Text>
          <Group gap="sm">
            {!tooBig && (
              <Button size="xs" onClick={() => reload()}>
                {t("Reload")}
              </Button>
            )}
            <Button
              size="xs"
              variant={tooBig ? "filled" : "default"}
              color="red"
              onClick={() => setConfirmOpen(true)}
            >
              {t("Discard this browser's copy")}
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
              {t("Discard and reload")}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
