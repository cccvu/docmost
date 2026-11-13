import { useEffect, useRef, useState } from "react";
import { Box, Button, Stack, Text, Title } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { ConfirmItsYouDialog } from "./confirm-its-you-dialog.tsx";

// wiki-v2 #818 — NOT upstream Docmost code. The full-page "confirm your email" reminder, shown once the wiki session is
// open after a PASSKEY sign-in whose email proof lapses within 30 days (the platform sends `emailConfirmationDueDays`
// only then; `usePasswordless` decides, never on an OAuth resume). A passkey works only while the last email-code
// sign-in or confirmation is at most 90 days old (owner decision 1), so the fix is an emailed code: the dialog runs
// with the email method ONLY (a passkey step-up records no mailbox proof and would change nothing).

export interface PasskeyReminderProps {
  /** Whole days left before passkeys stop working (1–30). */
  daysLeft: number;
  /** Leave the screen for the page the person was going to. */
  onDone: () => void;
}

const EMAIL_ONLY = ["email"] as const;

export function PasskeyReminder({ daysLeft, onDone }: PasskeyReminderProps) {
  const { t } = useTranslation();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  // A full-page screen focuses its heading (#818 contract §7).
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    if (confirmed) doneRef.current?.focus();
  }, [confirmed]);

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
        {t("Confirm your email to keep your passkey working")}
      </Title>
      {!confirmed && (
        <Text c="dimmed" ta="center">
          {daysLeft <= 1
            ? t(
                "Your passkey stops working tomorrow. Confirm your email with a code to keep using it.",
              )
            : t(
                "Your passkey stops working in {{days}} days. Confirm your email with a code to keep using it.",
                { days: daysLeft },
              )}
        </Text>
      )}

      <Box role="status" aria-live="polite" ta="center">
        {confirmed ? (
          <Text size="sm">
            {t("Thanks, your email is confirmed. Your passkey keeps working.")}
          </Text>
        ) : null}
      </Box>

      {confirmed ? (
        <Button ref={doneRef} fullWidth onClick={onDone}>
          {t("Continue")}
        </Button>
      ) : (
        <>
          <Button fullWidth onClick={() => setConfirming(true)}>
            {t("Confirm my email")}
          </Button>
          <Button variant="default" fullWidth onClick={onDone}>
            {t("Not now")}
          </Button>
        </>
      )}

      <ConfirmItsYouDialog
        opened={confirming}
        methods={EMAIL_ONLY}
        reason={t(
          "We'll email you a code. Entering it keeps your passkeys working for another 90 days.",
        )}
        onClose={() => setConfirming(false)}
        onConfirmed={() => {
          setConfirming(false);
          setConfirmed(true);
        }}
      />
    </Stack>
  );
}
