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
 */
import { Logger } from '@nestjs/common';

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
  const line = `${COLLAB_ORDER_DIVERGENCE_TOKEN} ${JSON.stringify({
    page: entry.page,
    where: entry.where,
    structs: entry.structs,
    ms: Math.round(entry.ms),
    suspects: entry.suspects.slice(0, ORDER_DIVERGENCE_SUSPECTS_MAX),
    outcome: entry.outcome,
  })}`;
  if (alert && sink.error) sink.error(line);
  else sink.warn(line);
}
