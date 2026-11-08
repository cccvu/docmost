import platformApi from "@/lib/platform-client";
import type { FeedbackPayload, FeedbackReceipt } from "./feedback.schema";

/**
 * Send one feedback report to the platform (`POST /v1/feedback`, same-origin, session cookie). The
 * `Idempotency-Key` is per draft: a retry of the same draft reuses it, so an attempt whose outcome was
 * unknown (504) is never sent twice.
 */
export async function submitFeedback(
  payload: FeedbackPayload,
  idempotencyKey: string,
): Promise<FeedbackReceipt> {
  const res = await platformApi.post<FeedbackReceipt>("/v1/feedback", payload, {
    headers: { "Idempotency-Key": idempotencyKey },
  });
  return res.data;
}

export interface FeedbackStatus {
  enabled: boolean;
}

/** Whether the platform has feedback configured (read-only; decides whether the menu item shows). */
export async function getFeedbackStatus(): Promise<FeedbackStatus> {
  const res = await platformApi.get<FeedbackStatus>("/v1/feedback/status");
  return res.data;
}
