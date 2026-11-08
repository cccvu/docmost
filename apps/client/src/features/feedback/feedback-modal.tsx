import { type RefObject, useEffect, useRef, useState } from "react";
import {
  Alert,
  Anchor,
  Button,
  Checkbox,
  Group,
  Modal,
  Radio,
  Stack,
  Text,
  TextInput,
  Textarea,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { useClipboard, useMediaQuery } from "@mantine/hooks";
import { zod4Resolver } from "mantine-form-zod-resolver";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { loginHrefWithReturn } from "@/lib/app-route";
import {
  buildFeedbackPayload,
  DESCRIPTION_MAX,
  EMPTY_FEEDBACK_DRAFT,
  feedbackFormSchema,
  TITLE_MAX,
  type FeedbackFormValues,
  type FeedbackPayload,
  type FeedbackType,
} from "./feedback.schema";
import { submitFeedback } from "./feedback-service";
import {
  classifyFeedbackError,
  formatWait,
  type FeedbackFailure,
} from "./feedback-errors";
import {
  FEEDBACK_STATUS_QUERY_KEY,
  type FeedbackEntry,
} from "./use-feedback-entry";
import { useCurrentPageId } from "./use-current-page-id";

const FIELD_IDS: Record<string, string> = {
  type: "feedback-type",
  title: "feedback-title",
  description: "feedback-description",
};

const PLACEHOLDERS: Record<FeedbackType | "", string> = {
  bug: "What happened, and what did you expect instead? Steps to reproduce help.",
  feature: "What would you like to be able to do, and why?",
  general: "Tell us what's on your mind.",
  "": "Tell us what's on your mind.",
};

function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // crypto.randomUUID needs a secure context; fall back to getRandomValues (RFC 4122 v4 layout).
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Fork-owned "Send feedback" dialog (#764). Rendered as a SIBLING of the account menu and kept mounted, so
 * the draft (form state, idempotency key) survives closing the dialog; it is cleared only after a send
 * succeeds. Every outcome is an inline, focused message (role=alert / role=status), never a toast.
 */
export function FeedbackModal({ entry }: { entry: FeedbackEntry }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const fullScreen = useMediaQuery("(max-width: 48em)");
  const pageId = useCurrentPageId(entry.opened);
  const clipboard = useClipboard({ timeout: 2000 });

  const form = useForm<FeedbackFormValues>({
    validate: zod4Resolver(feedbackFormSchema),
    initialValues: EMPTY_FEEDBACK_DRAFT,
  });

  // One key per draft: reused for every retry of the same body (so an unconfirmed send is never duplicated),
  // replaced after a success. An edited body gets a fresh key — the platform refuses a reused key with a
  // different body (409 idempotency_key_reused), and an edit is the reporter's new report.
  const keyRef = useRef<{ key: string; body: string } | null>(null);
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<FeedbackFailure | null>(null);
  const [sent, setSent] = useState<{ reference: string | null } | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);

  // The status probe already saw a 401: lead with "Sign in again" instead of letting a send fail first.
  const shown: FeedbackFailure | null =
    failure ?? (entry.needsSignIn && !sent ? { kind: "unauthenticated" } : null);

  useEffect(() => {
    if (failure) alertRef.current?.focus();
  }, [failure]);

  useEffect(() => {
    if (sent) statusRef.current?.focus();
  }, [sent]);

  function keyFor(payload: FeedbackPayload): string {
    const body = JSON.stringify(payload);
    if (!keyRef.current || keyRef.current.body !== body) {
      keyRef.current = { key: newIdempotencyKey(), body };
    }
    return keyRef.current.key;
  }

  async function onSubmit(values: FeedbackFormValues) {
    if (submittingRef.current) return;
    const payload = buildFeedbackPayload(values, pageId);
    const key = keyFor(payload);
    submittingRef.current = true;
    setSubmitting(true);
    setFailure(null);
    try {
      const receipt = await submitFeedback(payload, key);
      keyRef.current = null;
      form.reset();
      setSent({
        reference:
          typeof receipt?.reference === "string" ? receipt.reference : null,
      });
      void queryClient.invalidateQueries({
        queryKey: FEEDBACK_STATUS_QUERY_KEY,
      });
    } catch (error) {
      setFailure(classifyFeedbackError(error, t));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  function onValidationFailure(errors: Record<string, unknown>) {
    const first = Object.keys(errors)[0];
    const id = first ? FIELD_IDS[first] : undefined;
    if (id) document.getElementById(id)?.focus();
  }

  function onClose() {
    entry.close();
    // The draft stays; a finished send or a stale error message does not.
    setSent(null);
    setFailure(null);
  }

  function fieldError(name: keyof FeedbackFormValues) {
    const error = form.errors[name];
    return error ? t(String(error)) : undefined;
  }

  return (
    <Modal
      opened={entry.opened}
      onClose={onClose}
      // The opener (a menu item) has unmounted; focus goes back to the account menu trigger instead.
      returnFocus={false}
      onExitTransitionEnd={entry.restoreFocus}
      title={t("Send feedback")}
      fullScreen={fullScreen}
      centered
      size="lg"
      closeButtonProps={{ "aria-label": t("Close") }}
    >
      {sent ? (
        <Stack>
          <Alert
            ref={statusRef}
            tabIndex={-1}
            color="green"
            role="status"
          >
            {sent.reference
              ? t("Thanks — sent. Reference {{reference}}", {
                  reference: sent.reference,
                })
              : t("Thanks — sent.")}
          </Alert>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setSent(null)}>
              {t("Send more feedback")}
            </Button>
            <Button onClick={onClose}>{t("Close")}</Button>
          </Group>
        </Stack>
      ) : (
        <form onSubmit={form.onSubmit(onSubmit, onValidationFailure)} noValidate>
          <Stack>
            {shown && (
              <FailureAlert
                failure={shown}
                alertRef={alertRef}
                copyText={() =>
                  clipboard.copy(
                    `${form.values.title.trim()}\n\n${form.values.description.trim()}`,
                  )
                }
                copied={clipboard.copied}
              />
            )}

            <Radio.Group
              label={t("What kind of feedback?")}
              errorProps={{ role: "alert" }}
              {...form.getInputProps("type")}
              error={fieldError("type")}
            >
              <Group mt="xs">
                <Radio id={FIELD_IDS.type} value="bug" label={t("Bug")} />
                <Radio value="feature" label={t("Feature idea")} />
                <Radio value="general" label={t("Other")} />
              </Group>
            </Radio.Group>

            <TextInput
              id={FIELD_IDS.title}
              label={t("Summary")}
              maxLength={TITLE_MAX}
              description={`${form.values.title.length}/${TITLE_MAX}`}
              inputWrapperOrder={["label", "input", "description", "error"]}
              errorProps={{ role: "alert" }}
              {...form.getInputProps("title")}
              error={fieldError("title")}
            />

            <Textarea
              id={FIELD_IDS.description}
              label={t("Details")}
              placeholder={t(PLACEHOLDERS[form.values.type])}
              autosize
              minRows={5}
              maxRows={12}
              maxLength={DESCRIPTION_MAX}
              description={`${form.values.description.length}/${DESCRIPTION_MAX}`}
              inputWrapperOrder={["label", "input", "description", "error"]}
              errorProps={{ role: "alert" }}
              {...form.getInputProps("description")}
              error={fieldError("description")}
            />

            {pageId && (
              <Checkbox
                label={t("Include a link to this page")}
                {...form.getInputProps("includePage", { type: "checkbox" })}
              />
            )}

            <Text size="sm" c="dimmed">
              {t(
                "Your browser version is included. This goes to the development team — don't include passwords or confidential content.",
              )}
            </Text>

            <Group justify="flex-end">
              <Button variant="default" onClick={onClose}>
                {t("Close")}
              </Button>
              <Button type="submit" loading={submitting}>
                {shown ? t("Try again") : t("Send feedback")}
              </Button>
            </Group>
          </Stack>
        </form>
      )}
    </Modal>
  );
}

function FailureAlert({
  failure,
  alertRef,
  copyText,
  copied,
}: {
  failure: FeedbackFailure;
  alertRef: RefObject<HTMLDivElement | null>;
  copyText: () => void;
  copied: boolean;
}) {
  const { t } = useTranslation();
  const common = {
    ref: alertRef,
    tabIndex: -1,
    role: "alert" as const,
  };

  switch (failure.kind) {
    case "unauthenticated":
      return (
        <Alert {...common} color="yellow" title={t("Your session has expired")}>
          <Text size="sm">
            {t(
              "Sign in again in a new tab, then come back and select Try again. Your draft is kept.",
            )}
          </Text>
          <Anchor
            href={loginHrefWithReturn()}
            target="_blank"
            rel="noopener"
            size="sm"
          >
            {t("Sign in again")}
          </Anchor>
        </Alert>
      );
    case "rate_limited":
      return (
        <Alert {...common} color="yellow">
          <Text size="sm">
            {failure.waitSeconds === null
              ? t("You've reached the feedback limit for now. Please try again later.")
              : t(
                  "You've reached the feedback limit for now. Please try again in about {{wait}}.",
                  { wait: formatWait(failure.waitSeconds, t) },
                )}
          </Text>
          {failure.detail && (
            <Text size="sm" c="dimmed">
              {failure.detail}
            </Text>
          )}
        </Alert>
      );
    case "outcome_unknown":
      return (
        <Alert {...common} color="yellow">
          {t("We couldn't confirm it arrived. Trying again won't send it twice.")}
        </Alert>
      );
    case "unavailable":
      return (
        <Alert {...common} color="gray" title={t("Feedback is off right now")}>
          <Text size="sm">
            {t("Nothing was sent. Copy your text to keep it, and try again later.")}
          </Text>
          <Button size="xs" variant="default" mt="xs" onClick={copyText}>
            {copied ? t("Copied") : t("Copy text")}
          </Button>
        </Alert>
      );
    case "blocked":
      return (
        <Alert {...common} color="red">
          {t(
            "Something in your text was blocked; remove code snippets and try again.",
          )}
        </Alert>
      );
    default:
      return (
        <Alert {...common} color="red">
          {failure.message}
        </Alert>
      );
  }
}
