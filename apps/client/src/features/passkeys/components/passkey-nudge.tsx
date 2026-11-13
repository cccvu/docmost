import { useEffect, useRef, useState } from "react";
import { Box, Button, Stack, Text, Title } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { dismissPasskeyNudge } from "../lib/nudge-storage.ts";
import { passkeyUiAction, toPasskeyFailure } from "../lib/passkey-errors.ts";
import { registerPasskey } from "../services/passkey-api.ts";
import type { ConfirmMethod } from "../types.ts";
import { ConfirmItsYouDialog } from "./confirm-its-you-dialog.tsx";

// wiki-v2 #818 — NOT upstream Docmost code. The full-page "create a passkey" nudge, shown once the wiki session is
// open after an EMAIL sign-in on a device with a built-in authenticator, unless this device said "Don't ask again"
// (`usePasswordless` decides; never on an OAuth resume). The person has just entered an emailed code, so the session
// is fresh and the email proof is minutes old: "Create a passkey" normally goes straight to `create()`.
//
// "Create a passkey" calls `registerPasskey()` straight from the click (its one native fetch, then `create()`). If the
// platform still asks to confirm (a stale session, an old email proof), ConfirmItsYouDialog runs with the email
// method only, and a NEW "Continue" click starts the ceremony (Safari's gesture rule).

export interface PasskeyNudgeProps {
  /** Leave the screen for the page the person was going to. */
  onDone: () => void;
}

type Phase = "offer" | "confirm" | "continue" | "created";

export function PasskeyNudge({ onDone }: PasskeyNudgeProps) {
  const { t } = useTranslation();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const [phase, setPhase] = useState<Phase>("offer");
  const [confirmMethods, setConfirmMethods] = useState<ConfirmMethod[]>([
    "email",
  ]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  // A full-page screen focuses its heading (#818 contract §7), so a screen reader starts here.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    if (phase === "created") doneRef.current?.focus();
  }, [phase]);

  // Straight from the click: registerPasskey() does its one native fetch, then create(). No await before it.
  async function onCreate() {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    try {
      await registerPasskey();
      setPhase("created");
      setStatus(
        t(
          'Passkey created. Next time, choose "Sign in with a passkey" on this device.',
        ),
      );
    } catch (error) {
      const action = passkeyUiAction("add", toPasskeyFailure(error), t);
      switch (action.kind) {
        case "none":
          break;
        case "hide":
          // This platform has no passkeys (an older release): nothing to offer, so carry on.
          onDone();
          break;
        case "confirm":
          setConfirmMethods(action.methods);
          setPhase("confirm");
          break;
        case "message":
          setStatus(action.message);
          break;
        default:
          setStatus(t("Something went wrong. Try again."));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack gap="md">
      <Title
        order={1}
        size="h2"
        ta="center"
        fw={600}
        ref={headingRef}
        tabIndex={-1}
      >
        {phase === "created"
          ? t("Your passkey is ready")
          : t("Sign in faster with a passkey")}
      </Title>
      {phase !== "created" && (
        <>
          <Text c="dimmed" ta="center">
            {t(
              "Next time, sign in with your fingerprint, face or screen lock instead of waiting for an email.",
            )}
          </Text>
          <Text c="dimmed" ta="center" size="sm">
            {t("Only create a passkey on a device that's yours.")}
          </Text>
        </>
      )}

      {/* Polite: a refusal here is not an emergency, and "Not now" always works. */}
      <Box role="status" aria-live="polite" ta="center">
        {status ? <Text size="sm">{status}</Text> : null}
      </Box>

      {phase === "created" ? (
        <Button ref={doneRef} fullWidth onClick={onDone}>
          {t("Continue")}
        </Button>
      ) : (
        <>
          {phase === "continue" ? (
            <Button fullWidth onClick={() => void onCreate()} loading={busy}>
              {t("Continue")}
            </Button>
          ) : (
            <Button fullWidth onClick={() => void onCreate()} loading={busy}>
              {t("Create a passkey")}
            </Button>
          )}
          <Button variant="default" fullWidth onClick={onDone} disabled={busy}>
            {t("Not now")}
          </Button>
          <Button
            variant="subtle"
            fullWidth
            disabled={busy}
            onClick={() => {
              dismissPasskeyNudge();
              onDone();
            }}
          >
            {t("Don't ask again on this device")}
          </Button>
        </>
      )}

      <ConfirmItsYouDialog
        opened={phase === "confirm"}
        methods={confirmMethods}
        reason={t(
          "To add a passkey, confirm it's you with a code from your email.",
        )}
        onClose={() => setPhase("offer")}
        onConfirmed={() => {
          setStatus(t("Thanks. Now create your passkey."));
          setPhase("continue");
        }}
      />
    </Stack>
  );
}
