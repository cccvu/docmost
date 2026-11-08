import { z } from "zod/v4";

/**
 * Fork-owned "Send feedback" (#764). The client-side mirror of the platform's `POST /v1/feedback` DTO
 * (whitelisted: `type`, `title`, `description`, optional `pageId`; unknown fields are rejected). The
 * platform re-validates and normalizes everything; this only saves a round trip and shows field errors.
 */
export const FEEDBACK_TYPES = ["bug", "feature", "general"] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

export const TITLE_MIN = 3;
export const TITLE_MAX = 120;
export const DESCRIPTION_MIN = 10;
export const DESCRIPTION_MAX = 5000;

// Messages are i18n keys; the modal translates them when it renders a field error.
export const feedbackFormSchema = z.object({
  type: z.enum(FEEDBACK_TYPES, {
    error: "Choose what kind of feedback this is",
  }),
  title: z
    .string()
    .trim()
    .min(TITLE_MIN, { error: "Summary must be at least 3 characters" })
    .max(TITLE_MAX, { error: "Summary must be at most 120 characters" }),
  description: z
    .string()
    .trim()
    .min(DESCRIPTION_MIN, { error: "Details must be at least 10 characters" })
    .max(DESCRIPTION_MAX, {
      error: "Details must be at most 5000 characters",
    }),
  includePage: z.boolean(),
});

// The draft as the form holds it: `type` starts unselected so the reporter makes a deliberate choice.
export type FeedbackFormValues = {
  type: FeedbackType | "";
  title: string;
  description: string;
  includePage: boolean;
};

export const EMPTY_FEEDBACK_DRAFT: FeedbackFormValues = {
  type: "",
  title: "",
  description: "",
  includePage: false,
};

/** Exactly the contract's request body — nothing about the page beyond its id (no path, slug or title). */
export interface FeedbackPayload {
  type: FeedbackType;
  title: string;
  description: string;
  pageId?: string;
}

export interface FeedbackReceipt {
  reference: string;
  issueNumber: number;
}

/**
 * Build the request body from a validated draft. `pageId` is sent only when the reporter ticked
 * "Include a link to this page" AND the current page's id is known; the URL, space slug and page title
 * never leave the browser (the platform builds a title-free `/p/<id>` link itself).
 */
export function buildFeedbackPayload(
  values: FeedbackFormValues,
  pageId: string | undefined,
): FeedbackPayload {
  const payload: FeedbackPayload = {
    type: values.type as FeedbackType,
    title: values.title.trim(),
    description: values.description.trim(),
  };
  if (values.includePage && pageId) payload.pageId = pageId;
  return payload;
}
