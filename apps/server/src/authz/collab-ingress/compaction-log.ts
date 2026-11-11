/**
 * CCC collab integration — NOT upstream Docmost code (#827, ADR 0036).
 *
 * The one emitter of the compaction log lines, used by the update guard (a cap or a probe asked for compaction) and by
 * compaction itself (authz/page-write/compaction.ts: the load refusal, the request, the outcome). Same shape as every
 * collab-ingress line (`COLLAB_UPDATE_REFUSED`, `COLLAB_SOCKET_LIMIT`): the token, one space, one JSON object, its
 * discriminator first. So a query keys on `COLLAB_PAGE_COMPACTION {"event":"done"` and reads `pageId` from the JSON.
 *
 *   COLLAB_PAGE_COMPACTION {"event":"requested"|"done"|"skipped"|"load_refused","pageId":…,…}
 *   COLLAB_COMPACTION_FAILED {"pageId":…,"reason":…,"why":…}            (error level, with the error as the trace)
 *
 * Fields are fixed words, numbers, and page or user ids: never a document name a client sent, and never content.
 * check-infra-config §14 lists both tokens.
 */
import { Logger } from '@nestjs/common';
import type { CompactionRequest } from '../page-write/compaction-registry';

export const COLLAB_PAGE_COMPACTION_TOKEN = 'COLLAB_PAGE_COMPACTION';
export const COLLAB_COMPACTION_FAILED_TOKEN = 'COLLAB_COMPACTION_FAILED';

export type CompactionLogEvent = 'requested' | 'done' | 'skipped' | 'load_refused';
type Field = string | number | boolean | null | undefined;
export type CompactionLogFields = Record<string, Field>;

/** Where the lines go: a Nest Logger, or a spec's (or the guard's rate-limited) sink. */
export interface CompactionLogSink {
  warn(message: string): void;
  error?(message: string, trace?: unknown): void;
}

const defaultSink: CompactionLogSink = new Logger('CollabCompaction');

/** `COLLAB_PAGE_COMPACTION {"event":…,"pageId":…,…}` (undefined fields are left out, as JSON.stringify does). */
export function logPageCompaction(
  event: CompactionLogEvent,
  pageId: string | null,
  fields: CompactionLogFields = {},
  sink: CompactionLogSink = defaultSink,
): void {
  sink.warn(`${COLLAB_PAGE_COMPACTION_TOKEN} ${JSON.stringify({ event, pageId, ...fields })}`);
}

/** The `requested` line: log it when `requestCompaction` returns true (once per request). */
export function logCompactionRequested(
  pageId: string | null,
  request: CompactionRequest,
  counts: { structs?: number; clientIds?: number; steps?: number } | null,
  sink: CompactionLogSink = defaultSink,
): void {
  logPageCompaction(
    'requested',
    pageId,
    { reason: request.reason, drain: request.drain, userId: request.userId ?? undefined, ...(counts ?? {}) },
    sink,
  );
}

/** `COLLAB_COMPACTION_FAILED {"pageId":…,"reason":…,"why":…}`, at error level with the error as its trace. */
export function logCompactionFailed(
  pageId: string | null,
  reason: string | null,
  why: string,
  err: unknown,
  sink: CompactionLogSink = defaultSink,
): void {
  const line = `${COLLAB_COMPACTION_FAILED_TOKEN} ${JSON.stringify({ pageId, reason, why })}`;
  if (sink.error) sink.error(line, err ?? undefined);
  else sink.warn(line);
}
