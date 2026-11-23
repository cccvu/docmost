// wiki-v2 #939 — NOT upstream Docmost code. The site announcement strip, rendered at the top of each shell's header
// (global, share, public) from the state the shell got from `useAnnouncement()`.
//
// Accessibility:
//   - A labelled <section> region (landmark), never role="alert": a standing notice is not an interruption, and an
//     alert would re-announce on every SPA remount.
//   - Severity is text plus icon, never colour alone. The strip is one line (fixed height, ellipsis); "Details"
//     opens a modal with the full message and the downtime lines.
//   - One visually hidden polite status line speaks only when the downtime STARTS mid-session (the "save your work"
//     moment). It stays mounted while the strip is hidden so it is in the tree before its text changes.
//   - Dismiss is a ≥24 px icon button with a name, shown only when dismissible; afterwards focus moves to <main>.
//   - While the strip shows, `scroll-padding-top` on <html> follows Mantine's `--app-shell-header-offset` (which
//     Mantine sets on :root), so keyboard focus and anchor scrolls land below the taller fixed header (WCAG 2.4.11).

import { useEffect, useId, useState } from "react";
import { Button, ActionIcon, Modal, Stack, Text, VisuallyHidden } from "@mantine/core";
import {
  IconAlertOctagon,
  IconAlertTriangle,
  IconInfoCircle,
  IconX,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { MAIN_CONTENT_ID } from "@/components/ui/skip-to-main";
import type { Announcement } from "./announcement-contract";
import type { AnnouncementPhase } from "./announcement-schedule";
import {
  durationParts,
  formatInstant,
  formatWindow,
  type FormattedInstant,
} from "./announcement-format";
import type { AnnouncementState } from "./use-announcement";
import classes from "./announcement-banner.module.css";

type T = (key: string, options?: Record<string, unknown>) => string;

const SEVERITY_ICON = {
  info: IconInfoCircle,
  warning: IconAlertTriangle,
  critical: IconAlertOctagon,
} as const;

function labelFor(a: Announcement, phase: AnnouncementPhase, t: T): string {
  if (phase === "in_progress") return t("Maintenance in progress");
  if (phase === "upcoming") return t("Scheduled maintenance");
  if (a.severity === "critical") return t("Urgent");
  if (a.severity === "warning") return t("Important");
  return t("Notice");
}

function instantText(f: FormattedInstant, t: T): string {
  return f.viewer
    ? t("{{time}} ({{local}} your time)", { time: f.central, local: f.viewer })
    : f.central;
}

function durationText(ms: number, t: T): string {
  const { hours, minutes } = durationParts(ms);
  const parts: string[] = [];
  if (hours > 0) parts.push(t("{{count}} hours", { count: hours }));
  if (minutes > 0 || hours === 0) parts.push(t("{{count}} minutes", { count: minutes }));
  return parts.join(" ");
}

/** The strip's compact time: the downtime start while upcoming, its end while in progress. */
function compactTime(a: Announcement, phase: AnnouncementPhase, t: T): string | null {
  if (a.downtimeStartsAt === null || a.downtimeEndsAt === null) return null;
  const w = formatWindow(a.downtimeStartsAt, a.downtimeEndsAt);
  if (phase === "upcoming") return t("Starts {{time}}", { time: w.start.central });
  if (phase === "in_progress") return t("Until {{time}}", { time: w.end.central });
  return null;
}

function DetailsBody({ a, t }: { a: Announcement; t: T }) {
  const hasDowntime = a.downtimeStartsAt !== null && a.downtimeEndsAt !== null;
  const w = hasDowntime ? formatWindow(a.downtimeStartsAt!, a.downtimeEndsAt!) : null;
  return (
    <Stack gap="sm">
      <Text size="sm" className={classes.fullMessage}>
        {a.message}
      </Text>
      {w && (
        <Stack gap={4}>
          <Text size="sm">
            <strong>{t("Downtime starts")}:</strong> {instantText(w.start, t)}
          </Text>
          <Text size="sm">
            <strong>{t("Downtime ends")}:</strong> {instantText(w.end, t)}
          </Text>
          <Text size="sm">
            <strong>{t("Expected duration")}:</strong> {durationText(w.durationMs, t)}
          </Text>
        </Stack>
      )}
      {!w && a.endsAt !== null && (
        <Text size="sm">
          <strong>{t("Shown until")}:</strong> {instantText(formatInstant(a.endsAt), t)}
        </Text>
      )}
      <Text size="xs" c="dimmed">
        {t("Times are shown in US Central time.")}
      </Text>
    </Stack>
  );
}

export function AnnouncementBanner({ state }: { state: AnnouncementState }) {
  const { t } = useTranslation();
  const labelId = useId();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const { visible, announcement: a, phase, dismissible, dismiss } = state;

  // Speak once when the downtime starts mid-session (previous-render state, not an effect).
  const [seenPhase, setSeenPhase] = useState(phase);
  const [liveText, setLiveText] = useState("");
  if (phase !== seenPhase) {
    setSeenPhase(phase);
    if (phase === "in_progress" && seenPhase !== null) {
      setLiveText(t("Maintenance has started. Save your work: editing may be unavailable until it ends."));
    }
  }

  useEffect(() => {
    if (!visible) return;
    const root = document.documentElement;
    const previous = root.style.scrollPaddingTop;
    root.style.scrollPaddingTop = "var(--app-shell-header-offset, 0px)";
    return () => {
      root.style.scrollPaddingTop = previous;
    };
  }, [visible]);

  const onDismiss = () => {
    setDetailsOpen(false);
    dismiss();
    document.getElementById(MAIN_CONTENT_ID)?.focus();
  };

  const status = (
    <VisuallyHidden role="status" aria-live="polite">
      {liveText}
    </VisuallyHidden>
  );

  if (!visible || !a || !phase) return status;

  const Icon = SEVERITY_ICON[a.severity];
  const label = labelFor(a, phase, t);
  const time = compactTime(a, phase, t);

  return (
    <>
      <section
        aria-labelledby={labelId}
        className={classes.banner}
        data-severity={a.severity}
        data-phase={phase}
      >
        <Icon size={18} className={classes.icon} aria-hidden="true" />
        <span id={labelId} className={classes.label}>
          {label}
        </span>
        {time && <span className={classes.time}>{time}</span>}
        <span className={classes.message}>{a.message}</span>
        <span className={classes.actions}>
          <Button
            variant="subtle"
            color="gray"
            size="xs"
            onClick={() => setDetailsOpen(true)}
            aria-haspopup="dialog"
          >
            {t("Details")}
          </Button>
          {dismissible && (
            <ActionIcon
              variant="subtle"
              color="gray"
              size={28}
              onClick={onDismiss}
              aria-label={t("Dismiss announcement")}
            >
              <IconX size={16} aria-hidden="true" />
            </ActionIcon>
          )}
        </span>
      </section>
      <Modal
        opened={detailsOpen}
        onClose={() => setDetailsOpen(false)}
        title={label}
        closeButtonProps={{ "aria-label": t("Close") }}
      >
        <DetailsBody a={a} t={t} />
      </Modal>
      {status}
    </>
  );
}
