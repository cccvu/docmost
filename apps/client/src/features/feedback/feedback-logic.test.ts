import { describe, expect, it } from "vitest";
import {
  buildFeedbackPayload,
  feedbackFormSchema,
  type FeedbackFormValues,
} from "./feedback.schema";
import {
  classifyFeedbackError,
  formatWait,
  problemCode,
} from "./feedback-errors";

const t = (key: string, o?: Record<string, unknown>) =>
  key.replace(/\{\{(\w+)\}\}/g, (_, n) => String(o?.[n]));

function httpError(
  status: number,
  data: unknown,
  headers: Record<string, string> = {},
) {
  return { isAxiosError: true, response: { status, data, headers } };
}

function problem(status: number, code: string, detail = "x") {
  return httpError(
    status,
    { type: "about:blank", title: "T", status, code, detail },
    { "content-type": "application/problem+json" },
  );
}

const valid: FeedbackFormValues = {
  type: "bug",
  title: "Search is slow",
  description: "Searching for anything takes ten seconds.",
  includePage: false,
};

describe("feedback schema (mirrors the platform DTO)", () => {
  const ok = (v: Partial<FeedbackFormValues>) =>
    feedbackFormSchema.safeParse({ ...valid, ...v }).success;

  it("requires a chosen type from the closed set", () => {
    expect(ok({ type: "" })).toBe(false);
    expect(ok({ type: "question" as never })).toBe(false);
    for (const type of ["bug", "feature", "general"] as const) {
      expect(ok({ type })).toBe(true);
    }
  });

  it("bounds the summary to 3..120 characters after trimming", () => {
    expect(ok({ title: "ab" })).toBe(false);
    expect(ok({ title: "  ab  " })).toBe(false);
    expect(ok({ title: "abc" })).toBe(true);
    expect(ok({ title: "a".repeat(120) })).toBe(true);
    expect(ok({ title: "a".repeat(121) })).toBe(false);
  });

  it("bounds the details to 10..5000 characters after trimming", () => {
    expect(ok({ description: "123456789" })).toBe(false);
    expect(ok({ description: "1234567890" })).toBe(true);
    expect(ok({ description: "a".repeat(5000) })).toBe(true);
    expect(ok({ description: "a".repeat(5001) })).toBe(false);
  });
});

describe("buildFeedbackPayload", () => {
  it("sends exactly the contract fields, trimmed", () => {
    const body = buildFeedbackPayload(
      { ...valid, title: "  Search is slow ", description: " Takes ten seconds. " },
      "0b6a6f8e-8d1c-4b8a-9c41-1f0c1a2b3c4d",
    );
    expect(body).toEqual({
      type: "bug",
      title: "Search is slow",
      description: "Takes ten seconds.",
    });
    expect(Object.keys(body).sort()).toEqual(["description", "title", "type"]);
  });

  it("adds only the page id, and only when the reporter opted in on a page", () => {
    const id = "0b6a6f8e-8d1c-4b8a-9c41-1f0c1a2b3c4d";
    expect(buildFeedbackPayload({ ...valid, includePage: true }, id)).toEqual({
      type: "bug",
      title: valid.title,
      description: valid.description,
      pageId: id,
    });
    expect(
      "pageId" in buildFeedbackPayload({ ...valid, includePage: true }, undefined),
    ).toBe(false);
  });
});

describe("classifyFeedbackError", () => {
  it("401 is a lapsed session", () => {
    expect(classifyFeedbackError(problem(401, "unauthenticated"), t)).toEqual({
      kind: "unauthenticated",
    });
  });

  it("429 carries the Retry-After wait and the platform's own detail", () => {
    const err = httpError(
      429,
      { status: 429, code: "rate_limited", detail: "You reached your hourly limit." },
      { "content-type": "application/problem+json", "retry-after": "1800" },
    );
    expect(classifyFeedbackError(err, t)).toEqual({
      kind: "rate_limited",
      waitSeconds: 1800,
      detail: "You reached your hourly limit.",
    });
  });

  it("429 from the WAF (not problem+json) shows no server detail", () => {
    const err = httpError(
      429,
      { error: "x", message: "slow down" },
      { "retry-after": "60" },
    );
    expect(classifyFeedbackError(err, t)).toEqual({
      kind: "rate_limited",
      waitSeconds: 60,
      detail: null,
    });
  });

  it("the platform's coded 504 is a FINAL unknown outcome, with its reference", () => {
    const detail =
      "GitHub did not confirm the feedback (reference FB-0123456789), and it may have been sent.";
    expect(
      classifyFeedbackError(problem(504, "upstream_timeout", detail), t),
    ).toEqual({ kind: "outcome_unknown", final: true, reference: "FB-0123456789" });
    expect(classifyFeedbackError(problem(504, "upstream_timeout"), t)).toEqual({
      kind: "outcome_unknown",
      final: true,
      reference: null,
    });
  });

  it("an answer that never came from the platform is a retryable unknown outcome", () => {
    const retryable = { kind: "outcome_unknown", final: false, reference: null };
    for (const status of [500, 502, 504]) {
      expect(classifyFeedbackError(httpError(status, "<html/>"), t)).toEqual(retryable);
    }
    // A platform-coded 502 is "GitHub refused it, nothing sent", and a bare 503 never reached the platform.
    expect(classifyFeedbackError(problem(502, "upstream_error"), t).kind).toBe("other");
    expect(classifyFeedbackError(httpError(503, "<html/>"), t).kind).toBe("other");
  });

  it("409 idempotency_key_in_use: the first attempt is still being sent", () => {
    expect(classifyFeedbackError(problem(409, "idempotency_key_in_use"), t)).toEqual({
      kind: "in_flight",
    });
  });

  it("feedback_unavailable is 'off right now'; a transient 503 is not", () => {
    expect(classifyFeedbackError(problem(503, "feedback_unavailable"), t).kind).toBe(
      "unavailable",
    );
    expect(classifyFeedbackError(problem(503, "service_unavailable"), t)).toEqual({
      kind: "other",
      message: "Your feedback wasn't sent. (HTTP 503)",
    });
  });

  it("a 403 that is not problem+json is the WAF blocking the text", () => {
    expect(
      classifyFeedbackError(
        httpError(403, "<html>Forbidden</html>", { "content-type": "text/html" }),
        t,
      ).kind,
    ).toBe("blocked");
    expect(classifyFeedbackError(problem(403, "insufficient_scope"), t).kind).toBe(
      "other",
    );
  });

  it("a network failure says so", () => {
    expect(
      classifyFeedbackError({ isAxiosError: true, code: "ERR_NETWORK" }, t),
    ).toEqual({
      kind: "other",
      message: "Can't reach the wiki. Check your connection and try again.",
    });
  });

  it("problemCode ignores a JSON body that is not a problem document", () => {
    expect(problemCode(httpError(403, { code: "x" }))).toBeNull();
    expect(
      problemCode(
        httpError(403, { code: "x" }, { "content-type": "application/problem+json" }),
      ),
    ).toBe("x");
  });
});

describe("formatWait", () => {
  it("rounds up to minutes under an hour, hours beyond", () => {
    expect(formatWait(5, t)).toBe("1 minutes");
    expect(formatWait(1800, t)).toBe("30 minutes");
    expect(formatWait(3540, t)).toBe("59 minutes");
    expect(formatWait(3599, t)).toBe("1 hours");
    expect(formatWait(3600, t)).toBe("1 hours");
    expect(formatWait(5400, t)).toBe("2 hours");
  });
});
