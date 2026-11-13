import { useEffect, useRef, useState } from "react";
import { Alert, Button, Group, Modal, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { useResendCooldown } from "@/features/public/hooks/use-resend-cooldown.ts";
import { passkeyUiAction, toPasskeyFailure } from "../lib/passkey-errors.ts";
import { removePasskey } from "../services/passkey-api.ts";
import type {
  ConfirmMethod,
  PasskeyView,
  RemovePasskeyResponse,
} from "../types.ts";
import { ConfirmItsYouDialog } from "./confirm-its-you-dialog.tsx";

// wiki-v2 #818 — NOT upstream Docmost code. Profile → "Remove passkey {name}".
//
// ONE call does the whole removal: `DELETE /auth/passkeys/:id`. The platform stops the passkey, then signs the person
// out on every other device in BOTH planes (its own sessions and the wiki's) before it answers. The wiki makes no
// revoke call of its own. Its answers:
//   - `403 step_up_required`: ConfirmItsYouDialog with a passkey OR an emailed code (a removal must work while email is
//     down); then the person selects "Remove passkey" again. Nothing changed on the server.
//   - `503 sign_out_incomplete`: the passkey already no longer works, but the other-device sign-out did not finish.
//     "Try again" re-sends the same DELETE (it resumes), after the server's Retry-After.
//   - `404`: the passkey is gone already; the list is refreshed.

/** Longest the "Try again" button waits for a Retry-After: a misbehaving proxy must not lock it for an hour. */
const MAX_RETRY_WAIT_SECONDS = 60;
/** The wait when a 503 carried no Retry-After (the platform always sends 2–5 s). */
const DEFAULT_RETRY_WAIT_SECONDS = 3;

export interface RemovePasskeyDialogProps {
  /** The passkey being removed, or null when the dialog is closed. */
  passkey: PasskeyView | null;
  /** Its row name ("Passkey" or the provider). */
  name: string;
  /** It is the only passkey that still works: removing it leaves email as the only way in. */
  isLast: boolean;
  onClose: () => void;
  onRemoved: (result: RemovePasskeyResponse) => void;
  /** The list on screen is stale (a half-finished removal, or the passkey was already gone). */
  onChanged: () => void;
}

export function RemovePasskeyDialog(props: RemovePasskeyDialogProps) {
  if (!props.passkey) return null;
  // Keyed: every passkey starts with a clean dialog.
  return (
    <RemoveFlow key={props.passkey.id} {...props} passkey={props.passkey} />
  );
}

type Incomplete = { message: string };

function RemoveFlow({
  passkey,
  name,
  isLast,
  onClose,
  onRemoved,
  onChanged,
}: RemovePasskeyDialogProps & { passkey: PasskeyView }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [incomplete, setIncomplete] = useState<Incomplete | null>(null);
  const [confirmMethods, setConfirmMethods] = useState<ConfirmMethod[] | null>(
    null,
  );
  const [confirmed, setConfirmed] = useState(false);
  const cooldown = useResendCooldown(DEFAULT_RETRY_WAIT_SECONDS);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A row whose earlier removal did not finish: the passkey already no longer works.
  const resuming = passkey.removalPending || incomplete !== null;

  async function remove() {
    if (busy) return;
    setBusy(true);
    setError(null);
    let result: RemovePasskeyResponse;
    try {
      result = await removePasskey(passkey.id);
    } catch (failure) {
      if (!mounted.current) return;
      setBusy(false);
      setConfirmed(false);
      const action = passkeyUiAction("remove", toPasskeyFailure(failure), t);
      switch (action.kind) {
        case "none":
          return;
        case "confirm":
          setConfirmMethods(action.methods);
          return;
        case "refresh-list":
          onChanged();
          onClose();
          return;
        case "removal-incomplete": {
          const wait = Math.min(
            action.retryAfterSeconds ?? DEFAULT_RETRY_WAIT_SECONDS,
            MAX_RETRY_WAIT_SECONDS,
          );
          setIncomplete({ message: action.message });
          cooldown.start(wait);
          // The row now shows "Removal not finished · Try again" behind the dialog.
          onChanged();
          return;
        }
        case "message":
          setError(action.message);
          return;
        default:
          setError(t("Something went wrong. Try again."));
          return;
      }
    }
    if (!mounted.current) return;
    setBusy(false);
    onRemoved(result);
  }

  const actionLabel = resuming ? t("Try again") : t("Remove passkey");

  return (
    <>
      <Modal
        opened={confirmMethods === null}
        onClose={onClose}
        title={
          resuming
            ? t("Finish removing passkey {{name}}", { name })
            : isLast
              ? t("Remove your only passkey?")
              : t("Remove passkey {{name}}?", { name })
        }
        centered
        closeButtonProps={{ "aria-label": t("Close") }}
      >
        <Stack>
          {resuming ? (
            <Text size="sm">
              {t(
                "This passkey no longer works, but signing you out on your other devices didn't finish.",
              )}
            </Text>
          ) : isLast ? (
            <Text size="sm">
              {t(
                "You'll sign in with an email code only, so if email isn't working you won't be able to sign in until it is.",
              )}
            </Text>
          ) : (
            <Text size="sm">
              {t("{{name}} will stop working for your account.", { name })}
            </Text>
          )}
          <Text size="sm">
            {t("This also signs you out on your other devices.")}
          </Text>
          {confirmed && (
            <Text size="sm" role="status">
              {t("You're confirmed. Select {{action}} to finish.", {
                action: actionLabel,
              })}
            </Text>
          )}
          {error && (
            <Alert color="red" variant="light" role="alert">
              {error}
            </Alert>
          )}
          {incomplete && (
            <Alert color="red" variant="light" role="alert">
              {incomplete.message}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose} disabled={busy}>
              {t("Cancel")}
            </Button>
            <Button
              color="red"
              loading={busy}
              disabled={cooldown.remaining > 0}
              onClick={() => void remove()}
              data-autofocus
            >
              {cooldown.remaining > 0
                ? t("Try again ({{seconds}}s)", { seconds: cooldown.remaining })
                : actionLabel}
            </Button>
          </Group>
        </Stack>
      </Modal>
      <ConfirmItsYouDialog
        opened={confirmMethods !== null}
        methods={confirmMethods ?? ["passkey", "email"]}
        reason={t("To remove a passkey, confirm it's you.")}
        onClose={() => setConfirmMethods(null)}
        onConfirmed={() => {
          setConfirmMethods(null);
          setConfirmed(true);
        }}
      />
    </>
  );
}
