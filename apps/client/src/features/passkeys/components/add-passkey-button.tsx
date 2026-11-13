import { useEffect, useRef, useState } from "react";
import { Alert, Button, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { passkeysSupported } from "../lib/capabilities.ts";
import { passkeyUiAction, toPasskeyFailure } from "../lib/passkey-errors.ts";
import { registerPasskey } from "../services/passkey-api.ts";
import type { ConfirmMethod, PasskeyView } from "../types.ts";
import { ConfirmItsYouDialog } from "./confirm-its-you-dialog.tsx";

// wiki-v2 #818 — NOT upstream Docmost code. Profile → "Add a passkey".
//
// The click calls `registerPasskey()` straight away: its one native options fetch, then `create()` (Safari's
// user-gesture rule, #818 contract §5.1). Adding needs a fresh sign-in AND a recent emailed code, so a
// `403 step_up_required` or `email_confirmation_required` opens ConfirmItsYouDialog with the emailed code ONLY (a
// passkey step-up records no mailbox proof). After it succeeds the ceremony is NOT started from the dialog's
// callback (that is several awaits away from any click): the button turns into "Continue", and THAT click runs it.

export interface AddPasskeyButtonProps {
  onAdded: (passkey: PasskeyView) => void;
  /** The platform has no passkey routes (an older platform task): hide the section. */
  onUnsupported: () => void;
}

export function AddPasskeyButton({
  onAdded,
  onUnsupported,
}: AddPasskeyButtonProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmMethods, setConfirmMethods] = useState<ConfirmMethod[] | null>(
    null,
  );
  const [confirmed, setConfirmed] = useState(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  if (!passkeysSupported()) {
    return (
      <Text size="sm" c="dimmed">
        {t("This browser can't create passkeys.")}
      </Text>
    );
  }

  // Runs synchronously from the click up to the ceremony's own options fetch: no await before registerPasskey().
  async function add() {
    if (busy) return;
    setBusy(true);
    setError(null);
    let added: PasskeyView;
    try {
      added = await registerPasskey();
    } catch (failure) {
      if (!mounted.current) return;
      setBusy(false);
      const action = passkeyUiAction("add", toPasskeyFailure(failure), t);
      switch (action.kind) {
        case "none":
          return;
        case "hide":
          onUnsupported();
          return;
        case "confirm":
          setConfirmed(false);
          setConfirmMethods(action.methods);
          return;
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
    setConfirmed(false);
    onAdded(added);
  }

  return (
    <Stack gap="xs" align="flex-start">
      {confirmed && (
        <Text size="sm" role="status">
          {t("You're confirmed. Select Continue to add your passkey.")}
        </Text>
      )}
      {error && (
        <Alert color="red" variant="light" role="alert">
          {error}
        </Alert>
      )}
      <Button
        variant={confirmed ? "filled" : "default"}
        size="xs"
        loading={busy}
        onClick={() => void add()}
      >
        {confirmed ? t("Continue") : t("Add a passkey")}
      </Button>
      <ConfirmItsYouDialog
        opened={confirmMethods !== null}
        methods={confirmMethods ?? ["email"]}
        reason={t(
          "To add a passkey, confirm it's you with a code from your email.",
        )}
        onClose={() => setConfirmMethods(null)}
        onConfirmed={() => {
          setConfirmMethods(null);
          setConfirmed(true);
        }}
      />
    </Stack>
  );
}
