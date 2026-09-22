/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * The pure connection-matching core of the account-disable collab force-disconnect (#455), factored OUT of
 * the upstream `collaboration.gateway` so the enforcement predicate — "close every live socket whose
 * authenticated user is `userId`, and touch no one else" — is unit-testable WITHOUT loading the collab
 * WebSocket stack (Hocuspocus + lib0 ESM, which jest cannot parse). The gateway seam is then a one-line
 * delegate over `this.hocuspocus.documents.values()`, keeping the CCC footprint in the upstream file minimal.
 *
 * NODE-LOCAL: it only sees THIS node's resident documents (see the gateway doc-comment for the single-node /
 * `desired_count=1` scope + the documented multi-node follow-up). Returns the number of connections closed
 * (informational — the security outcome is enforced by `deactivatedAt`, which the caller sets first).
 */
export interface ClosableConnection {
  readonly context?: { user?: { id?: string } };
  close(): void;
}

export interface ConnectedDocument {
  getConnections(): Iterable<ClosableConnection>;
}

export function disconnectUserConnections(
  documents: Iterable<ConnectedDocument>,
  userId: string,
): number {
  let closed = 0;
  for (const doc of documents) {
    for (const connection of doc.getConnections()) {
      if (connection.context?.user?.id === userId) {
        connection.close();
        closed++;
      }
    }
  }
  return closed;
}
