/**
 * CCC authorization integration — NOT upstream Docmost code (#781, ADR 0036).
 *
 * The Hocuspocus extension that puts the collab update guard (update-guard.ts) in front of every client frame. Its one
 * hook, `beforeHandleMessage`, is the only Hocuspocus 3.4.4 hook that runs before a frame applies (`beforeSync` is not
 * awaited; `onChange` runs after the broadcast). Registered FIRST by the gateway (seam #3) and outranking every other
 * extension, and deliberately synchronous: Hocuspocus chains the hooks of each frame as promises, and frames apply in
 * arrival order only while every frame's chain has the same length. It is the only `beforeHandleMessage` in the server
 * (collab-update-guard.wiring.spec.ts).
 */
import type { beforeHandleMessagePayload } from '@hocuspocus/server';
import { CollabUpdateGuard, type GuardFrame } from './update-guard';

export class CollabUpdateGuardExtension {
  /** Hocuspocus sorts extensions by priority, highest first (RedisSync is 1000; the rest default to 100). */
  readonly priority = 10_000;
  readonly extensionName = 'CollabUpdateGuard';

  constructor(readonly guard: CollabUpdateGuard = new CollabUpdateGuard()) {}

  /**
   * Returns undefined (apply) or throws `{ code: 4422, reason }` (Hocuspocus closes that document session with the
   * reason), synchronously. NEVER async and never a promise: typed as Hocuspocus's promise-returning hook only so the
   * extension is assignable to its `Extension` type.
   */
  beforeHandleMessage(payload: beforeHandleMessagePayload): Promise<void> {
    this.guard.check(payload as unknown as GuardFrame);
    return undefined as unknown as Promise<void>;
  }
}
