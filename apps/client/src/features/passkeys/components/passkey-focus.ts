// wiki-v2 #907 — NOT upstream Docmost code. Where focus goes when the "Remove passkey" dialog closes. The dialog
// unmounts while still open, so Mantine's own focus return never runs (it acts only on `opened` true → false) and the
// browser drops focus to <body>. The section restores it on purpose, in this order:
//   1. the row button that opened the dialog, if it is still on the page (Cancel, Escape, Close, a step-up cancel);
//   2. the same row's current action button ("Remove" was replaced by "Try again" after a half-finished removal);
//   3. the Passkeys heading (always after a removal or a 404: the row is about to leave the list).
// Never <body>: with no target at all the caller focuses nothing.

export interface PasskeyFocusReturn {
  /** The row button that opened the dialog. */
  trigger: HTMLElement | null;
  /** The passkey the dialog was for (its row's buttons carry `data-passkey-action={id}`). */
  passkeyId: string;
  /** The row is gone or going (removed, or already gone on the server): skip straight to the heading. */
  toHeading: boolean;
}

export function passkeyFocusTarget(
  pending: PasskeyFocusReturn,
  scope: ParentNode | null,
  heading: HTMLElement | null,
): HTMLElement | null {
  if (!pending.toHeading) {
    if (pending.trigger?.isConnected) return pending.trigger;
    const actions = scope?.querySelectorAll<HTMLElement>(
      "[data-passkey-action]",
    );
    for (const action of actions ?? []) {
      if (
        action.isConnected &&
        action.dataset.passkeyAction === pending.passkeyId
      )
        return action;
    }
  }
  return heading?.isConnected ? heading : null;
}
