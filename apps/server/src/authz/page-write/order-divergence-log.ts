/**
 * CCC collab integration — NOT upstream Docmost code (#840, ADR 0036).
 *
 * The emitter of the order-divergence line: a page whose live order and reload order differ (order-parity.ts), found at
 * a shadow rebuild, a join, a store, a load or a probe. Same shape as the other collab lines: the token, one space, one
 * JSON object.
 *
 *   COLLAB_ORDER_DIVERGENCE {"page":…,"where":"rebuild"|"join"|"store"|"load"|"probe","structs":…,"ms":…,"suspects":[…],"outcome":…}
 *
 * `suspects` are user ids (at most 8; empty where the caller cannot map client ids to users, as the persistence seam
 * cannot). `outcome` is a fixed word. Fields are fixed words, numbers and page or user ids: never content. An outcome
 * that leaves the page unavailable until an operator acts is logged at error level (`alert`). check-infra-config §14
 * lists the token.
 *
 * The load's lines (heal-image.ts) are rate-limited per page and outcome (`loadDivergenceLog`): one line per minute,
 * the rest counted into one `log_suppressed` line (`of` the outcome, `count`) when the window ends, through the update
 * guard's `RateLimitedWarn` window. A client retrying a page that answers try-later otherwise wrote a line per attempt.
 * Per outcome, so a `healed` after a run of `not_armed` is never the line held back.
 */
import { Logger } from '@nestjs/common';
import { RateLimitedWarn } from '../collab-ingress/socket-limit-log';

export const COLLAB_ORDER_DIVERGENCE_TOKEN = 'COLLAB_ORDER_DIVERGENCE';
export const ORDER_DIVERGENCE_SUSPECTS_MAX = 8;

export type OrderDivergenceWhere = 'rebuild' | 'join' | 'store' | 'load' | 'probe';

export interface OrderDivergence {
  page: string | null;
  where: OrderDivergenceWhere;
  /** Structs in the document checked (live). */
  structs: number;
  /** What the check (and the heal step it led to) cost, ms. */
  ms: number;
  suspects: readonly string[];
  outcome: string;
}

export interface OrderDivergenceSink {
  warn(message: string): void;
  error?(message: string): void;
}

const defaultSink: OrderDivergenceSink = new Logger('CollabOrderDivergence');

/** `COLLAB_ORDER_DIVERGENCE {…}`; `alert` logs it at error level. */
export function logOrderDivergence(entry: OrderDivergence, alert = false, sink: OrderDivergenceSink = defaultSink): void {
  const line = formatOrderDivergence(entry);
  if (alert && sink.error) sink.error(line);
  else sink.warn(line);
}

const formatOrderDivergence = (entry: OrderDivergence): string =>
  `${COLLAB_ORDER_DIVERGENCE_TOKEN} ${JSON.stringify({
    page: entry.page,
    where: entry.where,
    structs: entry.structs,
    ms: Math.round(entry.ms),
    suspects: entry.suspects.slice(0, ORDER_DIVERGENCE_SUSPECTS_MAX),
    outcome: entry.outcome,
  })}`;

/** Lines per (page, outcome) per 60 s window at the load. */
export const LOAD_DIVERGENCE_LINES_PER_MINUTE = 1;

export type OrderDivergenceLog = (entry: OrderDivergence, alert?: boolean) => void;

/**
 * The load's rate-limited emitter: at most LOAD_DIVERGENCE_LINES_PER_MINUTE lines per (page, outcome) per window, at the
 * level each asks for; the rest are counted into `COLLAB_ORDER_DIVERGENCE {"page","where":"load","outcome":"log_suppressed",
 * "of","count"}` at warn when the window ends. Keys are a page id and a fixed word, so the window holds at most one entry
 * per page loaded in it.
 */
export function rateLimitedOrderDivergenceLog(sink: OrderDivergenceSink = defaultSink, now?: () => number): OrderDivergenceLog {
  let alertNext = false;
  const lines = new RateLimitedWarn<string>({
    // RateLimitedWarn builds the line (setting the level) right before it writes it; its summaries are always warn.
    logger: {
      warn: (message) => {
        const alert = alertNext;
        alertNext = false;
        if (alert && sink.error) sink.error(message);
        else sink.warn(message);
      },
    },
    perKey: LOAD_DIVERGENCE_LINES_PER_MINUTE,
    summary: (key, count) => {
      const at = key.lastIndexOf('|');
      const page = key.slice(0, at);
      return `${COLLAB_ORDER_DIVERGENCE_TOKEN} ${JSON.stringify({ page: page === '' ? null : page, where: 'load', outcome: 'log_suppressed', of: key.slice(at + 1), count })}`;
    },
    now,
  });
  return (entry, alert = false) =>
    lines.warn(`${entry.page ?? ''}|${entry.outcome}`, () => {
      alertNext = alert;
      return formatOrderDivergence(entry);
    });
}

let loadLog: OrderDivergenceLog = rateLimitedOrderDivergenceLog();
/** The process's load emitter (heal-image.ts). */
export const loadDivergenceLog: OrderDivergenceLog = (entry, alert) => loadLog(entry, alert);
/** A fresh window (the specs: each starts with no line held back). */
export function resetLoadDivergenceLogForTests(sink?: OrderDivergenceSink, now?: () => number): void {
  loadLog = rateLimitedOrderDivergenceLog(sink, now);
}
