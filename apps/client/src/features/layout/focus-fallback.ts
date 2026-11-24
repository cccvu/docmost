// wiki-v2 #913 — NOT upstream Docmost code. Copied in services/admin-ui/src/focus-fallback.ts (AGPL boundary:
// the console cannot import fork code), keep the two in step.
/**
 * Put keyboard focus back on the page after a dialog or a refetch removed the element that held it.
 *
 * Acts ONLY when focus is already lost: activeElement is <body>, null, or a node no longer in the
 * document. When something still holds focus (Mantine returned it to a trigger that survived, or the user
 * moved on), it does nothing, so Cancel and Escape paths keep their normal behaviour.
 * Candidates are tried in order; the first one that is connected and not disabled wins. Use the most specific
 * target first (the next row action, the counterpart button) and a stable one last (a section heading with
 * tabIndex={-1}, or the page's primary "New …" button). With no usable candidate, nothing is focused.
 *
 * Returns the element it focused, or null.
 */
export function restoreFocus(
  ...candidates: (HTMLElement | null | undefined)[]
): HTMLElement | null {
  const active = document.activeElement;
  if (active && active !== document.body && active.isConnected) return null;
  for (const candidate of candidates) {
    if (!candidate || !candidate.isConnected) continue;
    if (candidate.matches(":disabled")) continue;
    candidate.focus();
    return candidate;
  }
  return null;
}
