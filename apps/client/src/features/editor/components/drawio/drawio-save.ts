import { notifications } from "@mantine/notifications";
import type { TFunction } from "i18next";

/**
 * CCC: shared handler for the draw.io explicit-Save path, used by both the node view
 * (`drawio-view.tsx`) and the bubble-menu editor (`drawio-menu.tsx`).
 *
 * Contract: on success it closes the modal; on failure it surfaces exactly ONE red toast
 * — with a stable `id` so a retried failed save REPLACES the toast instead of stacking a
 * new one each time — and it does NOT close the modal, so the (still-dirty) diagram is
 * never silently lost. Extracted so this then/catch isn't copy-pasted across the two
 * editors and so the contract is unit-testable: the save-error branch is live-exercised
 * in production (a WAF rule 403s SVG uploads — see issue 201), and a future "simplify"
 * that reverts to swallow-and-close would silently reintroduce the data-loss UX.
 */
export function runDrawioSave(
  savePromise: Promise<unknown>,
  close: () => void,
  t: TFunction,
): Promise<void> {
  return savePromise
    .then(() => {
      close();
    })
    .catch((err: unknown) => {
      // Log only a narrowed message, never the raw error object (an AxiosError carries
      // the request config incl. auth headers) — browser-console hardening (CCC).
      console.error(
        "drawio: failed to save diagram",
        err instanceof Error ? err.message : err,
      );
      notifications.show({
        id: "drawio-save-error",
        message: t("Failed to save the diagram. Please try again."),
        color: "red",
      });
    });
}
