import { describe, expect, it } from "vitest";
import { AxiosError, AxiosHeaders } from "axios";
import i18next from "i18next";
import catalog from "../../../../public/locales/en-US/translation.json";
import {
  PasskeyError,
  failureFromAxios,
  failureFromCeremony,
  failureFromResponse,
  httpFailure,
  isPasskeysUnsupportedByServer,
  passkeyUiAction,
  shouldSignalUnknownCredential,
  toPasskeyFailure,
  type PasskeyFailure,
  type PasskeyOperation,
  type PasskeyStage,
  ADD_BUDGET_NOTICE_SECONDS,
  PASSKEY_ADD_LIMIT,
} from "./passkey-errors.ts";

// #818 contract §7: the error code → UI table. `t` returns the key, so assertions read the English copy.
const t = (k: string, o?: Record<string, unknown>) =>
  k.replace(/{{(\w+)}}/g, (_: string, n: string) => String(o?.[n]));

const http = (
  status: number,
  code: string | null = null,
  stage: PasskeyStage = "request",
  extra: Record<string, unknown> = {},
): PasskeyFailure =>
  httpFailure(
    stage,
    status,
    code ? { code, message: "x", ...extra } : extra,
    null,
  );

function axiosError(
  status: number | null,
  data: unknown,
  headers: Record<string, string> = {},
) {
  const err = new AxiosError(
    "boom",
    status === null ? "ERR_NETWORK" : "ERR_BAD_RESPONSE",
  );
  if (status !== null) {
    err.response = {
      status,
      statusText: "",
      data,
      headers: new AxiosHeaders(headers),
      config: { headers: new AxiosHeaders() },
    };
  }
  return err;
}

describe("failure normalization", () => {
  it("reads code and email from a native options response, and a numeric Retry-After", async () => {
    const res = new Response(
      JSON.stringify({ code: "rate_limited", message: "slow down" }),
      { status: 429, headers: { "retry-after": "7" } },
    );
    expect(await failureFromResponse(res)).toEqual({
      kind: "http",
      stage: "options",
      status: 429,
      code: "rate_limited",
      email: null,
      limit: null,
      retryAfterSeconds: 7,
    });
  });

  it("reads the add budget's limit member (#818), only as a non-empty string", async () => {
    const res = new Response(
      JSON.stringify({
        code: "rate_limited",
        limit: "passkey_add",
        message: "x",
      }),
      { status: 429, headers: { "retry-after": "86400" } },
    );
    expect(await failureFromResponse(res)).toMatchObject({
      limit: "passkey_add",
      retryAfterSeconds: 86400,
    });
    expect(
      failureFromAxios(
        axiosError(429, { code: "rate_limited", limit: "passkey_add" }),
      ),
    ).toMatchObject({ limit: "passkey_add" });
    for (const limit of [42, ["passkey_add"], ""]) {
      expect(
        httpFailure("request", 429, { code: "rate_limited", limit }, "86400"),
      ).toMatchObject({ limit: null });
    }
  });

  it("survives a non-JSON body (a proxy's HTML page) and an HTTP-date Retry-After", async () => {
    const res = new Response("<html>nope</html>", {
      status: 404,
      headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" },
    });
    const f = await failureFromResponse(res);
    expect(f).toMatchObject({
      kind: "http",
      status: 404,
      code: null,
      retryAfterSeconds: null,
    });
  });

  it("never takes a non-string code or email", () => {
    expect(
      httpFailure("request", 403, { code: 42, email: ["a"] }, null),
    ).toMatchObject({
      code: null,
      email: null,
    });
    expect(httpFailure("request", 403, ["code"], null)).toMatchObject({
      code: null,
    });
  });

  it("maps axios answers, network failures and cancels", () => {
    expect(
      failureFromAxios(
        axiosError(403, {
          code: "email_confirmation_required",
          email: "a@b.test",
        }),
      ),
    ).toMatchObject({
      kind: "http",
      stage: "request",
      status: 403,
      email: "a@b.test",
    });
    expect(
      failureFromAxios(axiosError(503, {}, { "retry-after": "3" })),
    ).toMatchObject({
      retryAfterSeconds: 3,
    });
    expect(failureFromAxios(axiosError(null, null))).toEqual({
      kind: "network",
      stage: "request",
    });
    const cancelled = new AxiosError("c", "ERR_CANCELED");
    expect(failureFromAxios(cancelled)).toEqual({ kind: "cancelled" });
    expect(failureFromAxios(new Error("x"))).toEqual({ kind: "unknown" });
  });

  it("maps ceremony rejections by name", () => {
    const named = (name: string) => Object.assign(new Error("x"), { name });
    expect(failureFromCeremony(named("NotAllowedError"))).toEqual({
      kind: "cancelled",
    });
    expect(failureFromCeremony(named("AbortError"))).toEqual({
      kind: "cancelled",
    });
    expect(failureFromCeremony(named("InvalidStateError"))).toEqual({
      kind: "already-registered",
    });
    expect(failureFromCeremony(named("SecurityError"))).toEqual({
      kind: "ceremony",
      name: "SecurityError",
    });
    expect(failureFromCeremony("weird")).toEqual({
      kind: "ceremony",
      name: "Error",
    });
  });

  it("unwraps a PasskeyError", () => {
    const f: PasskeyFailure = { kind: "unavailable" };
    expect(toPasskeyFailure(new PasskeyError(f))).toBe(f);
    expect(toPasskeyFailure("nope")).toEqual({ kind: "unknown" });
  });
});

describe("signalUnknownCredential gate", () => {
  const CODES = [
    "passkey_not_recognized",
    "passkey_challenge_expired",
    "passkey_failed",
    "email_confirmation_required",
    "passkey_challenge_stale",
    "passkey_rejected",
    "passkey_limit_reached",
    "passkey_already_registered",
    "sign_out_incomplete",
    "step_up_required",
    "rate_limited",
    null,
  ];
  const STATUSES = [400, 401, 403, 404, 405, 409, 429, 503];

  it("fires for exactly one answer: a request-stage 401 passkey_not_recognized", () => {
    const hits: string[] = [];
    for (const stage of ["options", "ceremony", "request"] as const) {
      for (const status of STATUSES) {
        for (const code of CODES) {
          if (shouldSignalUnknownCredential(http(status, code, stage))) {
            hits.push(`${stage} ${status} ${code}`);
          }
        }
      }
    }
    expect(hits).toEqual(["request 401 passkey_not_recognized"]);
    for (const f of [
      { kind: "cancelled" },
      { kind: "already-registered" },
      { kind: "unavailable" },
      { kind: "unknown" },
      { kind: "network", stage: "request" },
      { kind: "ceremony", name: "NotAllowedError" },
    ] as PasskeyFailure[]) {
      expect(shouldSignalUnknownCredential(f)).toBe(false);
    }
  });
});

describe("older platform (404/405 on an options route)", () => {
  it("hides passkeys on login and Profile, falls back to email in the dialog", () => {
    for (const status of [404, 405]) {
      const f = http(status, null, "options");
      expect(isPasskeysUnsupportedByServer(f)).toBe(true);
      for (const op of ["signin", "autofill", "add"] as PasskeyOperation[]) {
        expect(passkeyUiAction(op, f, t)).toEqual({ kind: "hide" });
      }
      expect(passkeyUiAction("reauth", f, t)).toEqual({
        kind: "use-email",
        message: null,
      });
      // The list route is a GET (no options stage) but means the same.
      expect(passkeyUiAction("list", http(status), t)).toEqual({
        kind: "hide",
      });
    }
  });

  it("is not triggered by a 404 after the options step", () => {
    expect(isPasskeysUnsupportedByServer(http(404, null, "request"))).toBe(
      false,
    );
    expect(isPasskeysUnsupportedByServer(http(403, null, "options"))).toBe(
      false,
    );
    expect(passkeyUiAction("remove", http(404), t)).toEqual({
      kind: "refresh-list",
    });
  });
});

describe("the §7 table", () => {
  const msg = (op: PasskeyOperation, f: PasskeyFailure) => {
    const a = passkeyUiAction(op, f, t);
    return a.kind === "message" ? a : null;
  };

  it("sign-in codes", () => {
    expect(msg("signin", http(401, "passkey_not_recognized"))).toEqual({
      kind: "message",
      message: "That passkey isn't set up for this account anymore.",
      offerEmail: true,
      retry: false,
    });
    expect(msg("signin", http(401, "passkey_challenge_expired"))?.message).toBe(
      "That took too long. Choose your passkey again.",
    );
    expect(
      passkeyUiAction("autofill", http(401, "passkey_challenge_expired"), t),
    ).toEqual({
      kind: "rearm",
    });
    expect(msg("signin", http(401, "passkey_failed"))).toMatchObject({
      message: "We couldn't sign you in with that passkey.",
      offerEmail: true,
      retry: true,
    });
    expect(
      passkeyUiAction(
        "signin",
        http(403, "email_confirmation_required", "request", {
          email: "a@b.test",
        }),
        t,
      ),
    ).toEqual({ kind: "code-step", email: "a@b.test" });
    expect(
      passkeyUiAction("autofill", http(403, "email_confirmation_required"), t),
    ).toEqual({
      kind: "code-step",
      email: null,
    });
  });

  it("429 never re-arms autofill and offers email on login", () => {
    for (const op of ["signin", "autofill"] as PasskeyOperation[]) {
      expect(
        passkeyUiAction(op, http(429, "rate_limited", "options"), t),
      ).toEqual({
        kind: "message",
        message: "Too many attempts. Wait a moment, or email me a code.",
        offerEmail: true,
        retry: false,
      });
    }
    expect(msg("add", http(429))?.message).toBe(
      "Too many attempts, try again in a moment.",
    );
  });

  it("step-up and email-confirmation open the dialog with the allowed methods", () => {
    expect(passkeyUiAction("add", http(403, "step_up_required"), t)).toEqual({
      kind: "confirm",
      methods: ["email"],
    });
    expect(passkeyUiAction("remove", http(403, "step_up_required"), t)).toEqual(
      {
        kind: "confirm",
        methods: ["passkey", "email"],
      },
    );
    expect(
      passkeyUiAction("add", http(403, "email_confirmation_required"), t),
    ).toEqual({
      kind: "confirm",
      methods: ["email"],
    });
    expect(
      passkeyUiAction("reauth", http(403, "email_confirmation_required"), t),
    ).toEqual({
      kind: "use-email",
      message: "Confirm with a code from your email this time.",
    });
    expect(passkeyUiAction("reauth", { kind: "unavailable" }, t)).toEqual({
      kind: "use-email",
      message: null,
    });
  });

  it("authenticated-route codes", () => {
    expect(msg("add", http(400, "passkey_challenge_stale"))?.message).toBe(
      "That took too long. Try again.",
    );
    expect(msg("add", http(400, "passkey_rejected"))).toMatchObject({
      message: "That passkey didn't work for your account.",
      offerEmail: true,
    });
    expect(passkeyUiAction("reauth", http(400, "passkey_rejected"), t)).toEqual(
      {
        kind: "use-email",
        message: "That passkey didn't work for your account.",
      },
    );
    expect(msg("add", http(409, "passkey_limit_reached"))?.message).toBe(
      "You already have 10 passkeys. Remove one first.",
    );
    expect(msg("add", http(409, "passkey_already_registered"))?.message).toBe(
      "This device already has a passkey for your account.",
    );
    expect(msg("add", { kind: "already-registered" })?.message).toBe(
      "This device already has a passkey for your account.",
    );
    expect(
      passkeyUiAction(
        "remove",
        httpFailure("request", 503, { code: "sign_out_incomplete" }, "4"),
        t,
      ),
    ).toEqual({
      kind: "removal-incomplete",
      message: "Removal not finished. Try again.",
      retryAfterSeconds: 4,
    });
  });

  it("uncoded 503, 401 and network answers", () => {
    expect(msg("signin", http(503))?.message).toBe(
      "Sign-in is temporarily unavailable. Try again, or email me a code.",
    );
    expect(msg("remove", http(503))?.message).toBe(
      "Temporarily unavailable, try again.",
    );
    expect(msg("add", http(401))?.message).toBe(
      "Your session has ended. Sign in again.",
    );
    expect(msg("signin", { kind: "network", stage: "options" })?.message).toBe(
      "Couldn't reach the server. Check your connection and try again.",
    );
  });

  it("a cancel is silent on every surface", () => {
    for (const op of [
      "signin",
      "autofill",
      "reauth",
      "add",
      "remove",
      "list",
    ] as PasskeyOperation[]) {
      expect(passkeyUiAction(op, { kind: "cancelled" }, t)).toEqual({
        kind: "none",
      });
    }
  });
});

// #818 owner decision: the platform limits passkey ADDS per user (a few per 24 h) and answers the over-budget add
// with `429 rate_limited` + `limit: passkey_add` + a Retry-After of up to a day. "Try again in a moment" would be
// wrong for that long. The pk-register burst throttle on the same routes answers `rate_limited` without `limit`.
describe("the add budget (429 rate_limited, limit passkey_add)", () => {
  const limited = (
    retryAfter: string | null,
    stage: PasskeyStage = "request",
    code: string | null = "rate_limited",
    limit: string | null = PASSKEY_ADD_LIMIT,
  ) =>
    httpFailure(
      stage,
      429,
      {
        message: "x",
        ...(code ? { code } : {}),
        ...(limit ? { limit } : {}),
      },
      retryAfter,
    );
  const SHORT = "Too many attempts, try again in a moment.";

  // The real catalog through real i18next: proves the plural keys exist and that `count` picks the form.
  const real = i18next.createInstance();
  real.init({
    lng: "en-US",
    fallbackLng: "en-US",
    initAsync: false,
    resources: { "en-US": { translation: catalog } },
    interpolation: { escapeValue: false },
  });
  const realT = (k: string, o?: Record<string, unknown>) => real.t(k, o);

  it.each([
    [
      "86400",
      "You've added several passkeys recently. Try again in about 24 hours.",
    ],
    [
      "1800",
      "You've added several passkeys recently. Try again in about 30 minutes.",
    ],
    [
      "3600",
      "You've added several passkeys recently. Try again in about 1 hour.",
    ],
    [
      "3601",
      "You've added several passkeys recently. Try again in about 2 hours.",
    ],
    [
      "3599",
      "You've added several passkeys recently. Try again in about 1 hour.",
    ],
    [
      "91",
      "You've added several passkeys recently. Try again in about 2 minutes.",
    ],
  ])(
    "Retry-After %s on add says when, rounded up, from the catalog",
    (retryAfter, text) => {
      for (const stage of ["options", "request"] as const) {
        expect(
          passkeyUiAction("add", limited(retryAfter, stage), realT),
        ).toEqual({
          kind: "message",
          message: text,
          offerEmail: false,
          retry: false,
        });
      }
    },
  );

  it.each([["30"], [String(ADD_BUDGET_NOTICE_SECONDS)], [null]])(
    "Retry-After %s on add keeps the short copy",
    (retryAfter) => {
      expect(passkeyUiAction("add", limited(retryAfter), realT)).toEqual({
        kind: "message",
        message: SHORT,
        offerEmail: false,
        retry: false,
      });
    },
  );

  it("both plural forms of both messages are in the catalog (not just the key's own fallback)", () => {
    for (const unit of ["minutes", "hours"]) {
      const key = `You've added several passkeys recently. Try again in about {{count}} ${unit}.`;
      for (const count of [1, 2]) {
        expect(real.exists(key, { count }), `${unit} count=${count}`).toBe(
          true,
        );
      }
    }
  });

  it("the threshold is 90 s", () => {
    expect(ADD_BUDGET_NOTICE_SECONDS).toBe(90);
  });

  it("only the platform's rate_limited code names the add budget", () => {
    expect(
      passkeyUiAction("add", limited("86400", "request", null), realT),
    ).toMatchObject({ kind: "message", message: SHORT });
  });

  it.each([["900"], ["86400"]])(
    "a rate_limited without the limit member (the pk-register burst, Retry-After %s) keeps the short copy",
    (retryAfter) => {
      for (const stage of ["options", "request"] as const) {
        expect(
          passkeyUiAction(
            "add",
            limited(retryAfter, stage, "rate_limited", null),
            realT,
          ),
        ).toEqual({
          kind: "message",
          message: SHORT,
          offerEmail: false,
          retry: false,
        });
      }
    },
  );

  it("another limit name is not the add budget", () => {
    expect(
      passkeyUiAction(
        "add",
        limited("86400", "request", "rate_limited", "passkey_register"),
        realT,
      ),
    ).toMatchObject({ kind: "message", message: SHORT });
  });

  it("never on another operation: removal is never charged to the add budget", () => {
    for (const op of ["remove", "list", "reauth"] as PasskeyOperation[]) {
      expect(passkeyUiAction(op, limited("86400"), realT)).toMatchObject({
        kind: "message",
        message: SHORT,
      });
    }
    for (const op of ["signin", "autofill"] as PasskeyOperation[]) {
      expect(passkeyUiAction(op, limited("86400"), realT)).toMatchObject({
        kind: "message",
        message: "Too many attempts. Wait a moment, or email me a code.",
        offerEmail: true,
      });
    }
  });
});
