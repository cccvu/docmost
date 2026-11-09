import { useEffect, useRef, useState } from "react";
import { Alert, Button, Group, Modal, Stack, Text } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

/**
 * CCC fork addition (cccvu/wiki-v2#781) — shown once the server refused a collab frame from this editor
 * (`collab-access.ts`, `refused`). The provider is already detached and the editor read-only, so nothing more is sent.
 *
 *   - Reload (primary): a fresh Yjs clientID, keeping this browser's copy. Recovers a rolling-deploy skew. Not a
 *     clientID the server bound to someone else: the copy holds the refused edit under that ID and replays it.
 *   - Discard this browser's copy: after a confirm, clear the page's IndexedDB copy, then reload. For a copy the
 *     server refuses every time it is replayed. A failed clear does not reload (it would replay the same copy).
 *
 * Wired by page-editor.tsx (seam 169).
 */
export interface CollabRefusalNoticeProps {
  /** Clear this page's local (IndexedDB) copy: `clearLocalCollabCopy`. */
  clearLocalCopy: () => Promise<void>;
  reload?: () => void;
}

export function CollabRefusalNotice({
  clearLocalCopy,
  reload = () => window.location.reload(),
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
          <Text size="sm">
            {t(
              "The server could not accept a change from this browser, so editing is paused. Reload the page to continue. If that does not help, discard this browser's copy of the page.",
            )}
          </Text>
          <Group gap="sm">
            <Button size="xs" onClick={() => reload()}>
              {t("Reload")}
            </Button>
            <Button
              size="xs"
              variant="default"
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
              {t("Discard and reload")}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
