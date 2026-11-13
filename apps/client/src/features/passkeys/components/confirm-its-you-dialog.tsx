import {
  type ChangeEvent,
  type FormEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  Alert,
  Button,
  Group,
  Loader,
  Modal,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { isAxiosError } from "axios";
import { useTranslation } from "react-i18next";
import { useResendCooldown } from "@/features/public/hooks/use-resend-cooldown.ts";
import {
  OTP_INPUT_MAX_LENGTH,
  RESEND_COOLDOWN_SECONDS,
  hasMinimumDigits,
  isBulkEntry,
  isCompleteOtp,
  isRateLimited,
  normalizeOtp,
  tooManyRequestsMessage,
} from "@/features/public/otp-code.ts";
import {
  errorStatus,
  retryAfterMs,
  type Translate,
} from "@/features/request-errors/request-error.ts";
import { passkeysSupported } from "../lib/capabilities.ts";
import { passkeyUiAction, toPasskeyFailure } from "../lib/passkey-errors.ts";
import {
  probeReauthPasskey,
  reauthWithPasskey,
  requestReauthCode,
  verifyReauthCode,
} from "../services/passkey-api.ts";
import type { ConfirmMethod } from "../types.ts";

// wiki-v2 #818 — NOT upstream Docmost code. "Confirm it's you": re-proves the signed-in person in place, without
// leaving the wiki (it never goes through the console's confirm page). Two methods, allowed per use:
//   - email: `POST /auth/reauth/request` mails a code, `POST /auth/reauth/verify` checks it. A success makes the
//     platform session fresh AND records the mailbox proof that keeps passkeys working and lets one be added.
//   - passkey: `/auth/reauth/passkey/*`. Makes the session fresh only; it records no mailbox proof.
// So "Add a passkey" and the email-confirmation reminder pass `["email"]` (adding needs a recent email code, owner
// decision 2), and "Remove passkey" passes `["passkey", "email"]` (a removal must work while email is down).
//
// After `onConfirmed` the caller shows a NEW "Continue" button: a passkey ceremony may start only from a click.

export interface ConfirmItsYouDialogProps {
  opened: boolean;
  onClose: () => void;
  /** Runs once the person is re-proved (the platform session is fresh). May be async. */
  onConfirmed: () => void | Promise<void>;
  /** The methods this use allows, in no particular order. Email-only uses must pass `["email"]`. */
  methods: readonly ConfirmMethod[];
  /** One sentence saying why, shown above the method. */
  reason?: string;
}

function noResponse(error: unknown): boolean {
  return (
    isAxiosError(error) && !error.response && error.code !== "ERR_CANCELED"
  );
}

function bodyCode(error: unknown): string | null {
  if (!isAxiosError(error)) return null;
  const code = (error.response?.data as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : null;
}

function sendErrorMessage(error: unknown, t: Translate): string {
  if (isRateLimited(error)) return tooManyRequestsMessage(error, t);
  if (bodyCode(error) === "reauth_capped") {
    return t(
      "Too many wrong codes. Use your passkey if you have one, or sign out and sign in again.",
    );
  }
  if (errorStatus(error) === 401)
    return t("Your session has ended. Sign in again.");
  if (noResponse(error)) {
    return t("Couldn't reach the server. Check your connection and try again.");
  }
  return t("We couldn't send a code. Try again in a moment.");
}

function verifyErrorMessage(error: unknown, t: Translate): string {
  if (isRateLimited(error)) return tooManyRequestsMessage(error, t);
  if (errorStatus(error) === 401)
    return t("Your session has ended. Sign in again.");
  if (bodyCode(error) === "reauth_code_invalid" || errorStatus(error) === 400) {
    return t("That code is wrong or has expired. Request a new one.");
  }
  if (noResponse(error)) {
    return t("Couldn't reach the server. Check your connection and try again.");
  }
  return t("We couldn't check that code. Try again.");
}

export function ConfirmItsYouDialog(props: ConfirmItsYouDialogProps) {
  const { t } = useTranslation();
  return (
    <Modal
      opened={props.opened}
      onClose={props.onClose}
      title={t("Confirm it's you")}
      centered
      closeButtonProps={{ "aria-label": t("Close") }}
    >
      {/* Mounted only while open, so every opening starts clean (a new probe, a new code). */}
      {props.opened ? <ConfirmBody {...props} /> : null}
    </Modal>
  );
}

type Mode = "probing" | "choose" | "email" | "none";
type SendState =
  | { state: "idle" }
  | { state: "sending" }
  | { state: "sent"; email: string }
  | { state: "error"; message: string };

function ConfirmBody({
  onClose,
  onConfirmed,
  methods,
  reason,
}: ConfirmItsYouDialogProps) {
  const { t } = useTranslation();
  const allowsEmail = methods.includes("email");
  const allowsPasskey = methods.includes("passkey");

  const [mode, setMode] = useState<Mode>("probing");
  const [passkeyAvailable, setPasskeyAvailable] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const [emailNote, setEmailNote] = useState<string | null>(null);
  const [send, setSend] = useState<SendState>({ state: "idle" });
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const cooldown = useResendCooldown(RESEND_COOLDOWN_SECONDS);

  const started = useRef(false);
  const mounted = useRef(false);
  const autoSubmitted = useRef<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const passkeyButtonRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const codeErrorId = useId();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function sendCode() {
    setSend({ state: "sending" });
    // A new code supersedes the one in the field: clear it, so a pasted new code is not appended to the old one.
    setCode("");
    setCodeError(null);
    autoSubmitted.current = null;
    try {
      const { email } = await requestReauthCode();
      if (!mounted.current) return;
      setSend({ state: "sent", email });
      cooldown.start();
    } catch (error) {
      if (!mounted.current) return;
      const after = isRateLimited(error) ? retryAfterMs(error) : null;
      if (after !== null) cooldown.start(Math.ceil(after / 1000));
      setSend({ state: "error", message: sendErrorMessage(error, t) });
    }
  }

  /** Switch to the emailed code (and mail one), or say there is no way left when this use forbids email. */
  function startEmail(note: string | null) {
    setPasskeyError(null);
    if (!allowsEmail) {
      setMode("none");
      setEmailNote(note);
      return;
    }
    setEmailNote(note);
    setMode("email");
    void sendCode();
  }

  // Once per opening (a ref, so StrictMode's double effect neither probes nor mails twice).
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!allowsPasskey || !passkeysSupported()) {
      startEmail(null);
      return;
    }
    void probeReauthPasskey().then((available) => {
      if (!mounted.current) return;
      setPasskeyAvailable(available);
      if (available) setMode("choose");
      else startEmail(null);
    });
  }, []);

  // Focus follows the mode. The modal's own initial focus ran while the body was still "probing" (it lands on the close
  // button), so `data-autofocus` alone never reaches what the probe's answer shows.
  useEffect(() => {
    if (mode === "probing") return;
    const target =
      mode === "choose"
        ? passkeyButtonRef.current
        : mode === "email"
          ? codeRef.current
          : cancelRef.current;
    target?.focus();
  }, [mode]);

  async function finish() {
    setConfirming(true);
    try {
      await onConfirmed();
    } finally {
      if (mounted.current) setConfirming(false);
    }
  }

  // Called straight from the click: reauthWithPasskey's one native fetch, then get() (Safari's gesture rule).
  async function onUsePasskey() {
    if (passkeyBusy || confirming) return;
    setPasskeyError(null);
    setPasskeyBusy(true);
    try {
      await reauthWithPasskey();
    } catch (error) {
      if (!mounted.current) return;
      setPasskeyBusy(false);
      const action = passkeyUiAction("reauth", toPasskeyFailure(error), t);
      if (action.kind === "none") return;
      if (action.kind === "use-email" || action.kind === "hide") {
        setPasskeyAvailable(false);
        startEmail(action.kind === "use-email" ? action.message : null);
        return;
      }
      setPasskeyError(
        action.kind === "message" || action.kind === "removal-incomplete"
          ? action.message
          : t("Something went wrong. Try again."),
      );
      return;
    }
    if (!mounted.current) return;
    setPasskeyBusy(false);
    await finish();
  }

  async function verifyCode(value: string) {
    if (verifying || confirming) return;
    if (!isCompleteOtp(value)) {
      setCodeError(t("Enter the code from your email. It is 6 to 12 digits."));
      codeRef.current?.focus();
      return;
    }
    setCodeError(null);
    setVerifying(true);
    try {
      await verifyReauthCode(normalizeOtp(value));
    } catch (error) {
      if (!mounted.current) return;
      setVerifying(false);
      setCodeError(verifyErrorMessage(error, t));
      codeRef.current?.focus();
      codeRef.current?.select();
      return;
    }
    if (!mounted.current) return;
    setVerifying(false);
    await finish();
  }

  function onCodeChange(e: ChangeEvent<HTMLInputElement>) {
    const next = e.currentTarget.value;
    const inputType = (e.nativeEvent as InputEvent | undefined)?.inputType;
    const bulk = isBulkEntry(code, next, inputType);
    setCode(next);
    setCodeError(null);
    // A pasted or autofilled whole code submits itself, once. Typing never does.
    const normalized = normalizeOtp(next);
    if (bulk && isCompleteOtp(next) && autoSubmitted.current !== normalized) {
      autoSubmitted.current = normalized;
      void verifyCode(next);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void verifyCode(code);
  }

  const reasonText = reason ?? t("This change needs a recent sign-in.");
  const busy = passkeyBusy || verifying || confirming;

  if (mode === "probing") {
    return (
      <Stack>
        <Text size="sm">{reasonText}</Text>
        <Group gap="xs" aria-live="polite">
          <Loader size="xs" />
          <Text size="sm" c="dimmed">
            {t("Checking how you can confirm…")}
          </Text>
        </Group>
      </Stack>
    );
  }

  if (mode === "none") {
    return (
      <Stack>
        <Text size="sm">{reasonText}</Text>
        <Alert color="red" variant="light" role="alert">
          {emailNote ??
            t("No passkey is available for your account on this device.")}
        </Alert>
        <Group justify="flex-end">
          <Button ref={cancelRef} variant="default" onClick={onClose}>
            {t("Cancel")}
          </Button>
        </Group>
      </Stack>
    );
  }

  if (mode === "choose") {
    return (
      <Stack>
        <Text size="sm">{reasonText}</Text>
        {passkeyError && (
          <Alert color="red" variant="light" role="alert">
            {passkeyError}
          </Alert>
        )}
        <Button
          ref={passkeyButtonRef}
          onClick={() => void onUsePasskey()}
          loading={passkeyBusy || confirming}
          data-autofocus
        >
          {t("Use your passkey")}
        </Button>
        <Group justify="space-between">
          {allowsEmail ? (
            <Button
              variant="subtle"
              size="xs"
              onClick={() => startEmail(null)}
              disabled={busy}
            >
              {t("Email me a code instead")}
            </Button>
          ) : (
            <span />
          )}
          <Button variant="default" onClick={onClose} disabled={busy}>
            {t("Cancel")}
          </Button>
        </Group>
      </Stack>
    );
  }

  return (
    <form noValidate onSubmit={onSubmit}>
      <Stack>
        <Text size="sm">{reasonText}</Text>
        {emailNote && (
          <Text size="sm" role="status">
            {emailNote}
          </Text>
        )}
        {/* Polite status: where the code went. Errors are role="alert". */}
        <div aria-live="polite">
          {send.state === "sending" ? (
            <Group gap="xs">
              <Loader size="xs" />
              <Text size="sm" c="dimmed">
                {t("Sending a code to your email…")}
              </Text>
            </Group>
          ) : send.state === "sent" ? (
            <Text size="sm" c="dimmed">
              {t("We sent a code to {{email}}.", { email: send.email })}{" "}
              {t("If you don't see it, check your junk folder.")}
            </Text>
          ) : null}
        </div>
        {send.state === "error" && (
          <Alert color="red" variant="light" role="alert">
            {send.message}
          </Alert>
        )}
        {passkeyError && (
          <Alert color="red" variant="light" role="alert">
            {passkeyError}
          </Alert>
        )}
        <TextInput
          ref={codeRef}
          label={t("Confirmation code")}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={OTP_INPUT_MAX_LENGTH}
          value={code}
          onChange={onCodeChange}
          error={codeError ? true : undefined}
          aria-describedby={codeError ? codeErrorId : undefined}
          required
          data-autofocus
        />
        {codeError && (
          <Alert id={codeErrorId} color="red" variant="light" role="alert">
            {codeError}
          </Alert>
        )}
        <Group justify="space-between">
          <Group gap="xs">
            <Button
              variant="subtle"
              size="xs"
              onClick={() => void sendCode()}
              loading={send.state === "sending"}
              disabled={cooldown.remaining > 0 || busy}
            >
              {cooldown.remaining > 0
                ? t("Resend code ({{seconds}}s)", {
                    seconds: cooldown.remaining,
                  })
                : t("Resend code")}
            </Button>
            {allowsPasskey && passkeyAvailable && (
              <Button
                variant="subtle"
                size="xs"
                onClick={() => void onUsePasskey()}
                loading={passkeyBusy}
                disabled={busy}
              >
                {t("Use your passkey instead")}
              </Button>
            )}
          </Group>
          <Group gap="xs">
            <Button variant="default" onClick={onClose} disabled={busy}>
              {t("Cancel")}
            </Button>
            <Button
              type="submit"
              loading={verifying || confirming}
              disabled={!hasMinimumDigits(code) || passkeyBusy}
            >
              {t("Verify")}
            </Button>
          </Group>
        </Group>
      </Stack>
    </form>
  );
}
