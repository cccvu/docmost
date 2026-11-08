// CCC (issue #145): browser wiring for new-version-check.ts. On focus or when the tab becomes visible,
// probe `/` (throttled, see new-version-check.ts) and, once a newer build is confirmed, show ONE persistent,
// non-blocking notification with a Reload action. Started once from main.tsx (seam #120).
import { Button, Group, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import i18n from "i18next";
import { createNewVersionChecker, fetchIndexHtml } from "./new-version-check";

export const NEW_VERSION_NOTIFICATION_ID = "ccc-new-version";

/** The running document's entry script, as Vite's production build writes it. Null in the dev server. */
export function runningEntrySrc(doc: Document = document): string | null {
  return (
    doc
      .querySelector('script[type="module"][src*="/assets/"]')
      ?.getAttribute("src") ?? null
  );
}

export function showNewVersionNotification(reload: () => void = () => window.location.reload()) {
  notifications.show({
    id: NEW_VERSION_NOTIFICATION_ID,
    autoClose: false,
    withCloseButton: true,
    message: (
      <Group justify="space-between" wrap="nowrap" gap="sm">
        <Text size="sm">{i18n.t("A new version is available")}</Text>
        <Button size="xs" variant="light" onClick={reload}>
          {i18n.t("Reload")}
        </Button>
      </Group>
    ),
  });
}

let started = false;

/** Idempotent. Does nothing when the running build cannot be identified (e.g. the Vite dev server). */
export function startNewVersionWatcher(): void {
  if (started || typeof window === "undefined") return;
  const running = runningEntrySrc();
  if (!running) return;
  started = true;
  const checker = createNewVersionChecker({
    running,
    fetchHtml: () => fetchIndexHtml(),
    now: Date.now,
    onNudge: () => showNewVersionNotification(),
  });
  const check = () => void checker.check();
  window.addEventListener("focus", check);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") check();
  });
}
