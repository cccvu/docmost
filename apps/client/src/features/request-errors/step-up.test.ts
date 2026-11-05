import { describe, expect, it } from "vitest";
import { AxiosError, AxiosHeaders } from "axios";
import {
  STEP_UP_CONFIRM_PATH,
  stepUpConfirmHref,
  stepUpRedirectFor,
} from "./step-up";

// wiki-v2 #713: the engine's `403 {code: "step_up_required"}` sends the browser to the console's confirm page, which
// returns it here; nothing else does.

const ORIGIN = window.location.origin;
const STEP_UP = { message: "Recent sign-in required", code: "step_up_required" };
const at = (pathname: string, search = "") => ({ pathname, search });

// A real AxiosError, as the api client rejects with (the XHR adapter sets request.responseURL).
function httpError(
  status: number,
  data: unknown,
  path = "/api/pages/delete",
  responseURL: string | undefined = `${ORIGIN}${path}`,
): AxiosError {
  return new AxiosError(
    "Request failed",
    "ERR_BAD_REQUEST",
    { baseURL: "/api", url: path.replace(/^\/api/, ""), headers: new AxiosHeaders() },
    responseURL === undefined ? {} : { responseURL },
    {
      status,
      statusText: String(status),
      data,
      headers: {},
      config: { headers: new AxiosHeaders() },
    },
  );
}

const confirmFor = (back: string) =>
  `${STEP_UP_CONFIRM_PATH}?return=${encodeURIComponent(back)}`;

describe("stepUpRedirectFor", () => {
  it("sends a step_up_required 403 to the console confirm page, returning to the current path and query", async () => {
    await expect(
      stepUpRedirectFor(httpError(403, STEP_UP), at("/s/eng/p/abc", "?tab=trash")),
    ).resolves.toBe(confirmFor("/s/eng/p/abc?tab=trash"));
  });

  it("falls back to the axios config path when the transport exposes no responseURL", async () => {
    await expect(
      stepUpRedirectFor(
        httpError(403, STEP_UP, "/api/pages/restrict", undefined),
        at("/s/eng/p/abc"),
      ),
    ).resolves.toBe(confirmFor("/s/eng/p/abc"));
  });

  it("reads the code from a JSON Blob body (a blob-typed request)", async () => {
    const blob = new Blob([JSON.stringify(STEP_UP)], { type: "application/json" });
    await expect(
      stepUpRedirectFor(httpError(403, blob, "/api/spaces/export"), at("/s/eng")),
    ).resolves.toBe(confirmFor("/s/eng"));
  });

  it.each<[string, AxiosError | unknown]>([
    ["a plain 403 (a CASL deny)", httpError(403, { message: "Forbidden", statusCode: 403 })],
    ["a 403 with another code", httpError(403, { code: "forbidden" })],
    ["a 401 carrying the code (that is the session-expired path)", httpError(401, STEP_UP)],
    ["a 404", httpError(404, STEP_UP)],
    ["a non-JSON Blob", httpError(403, new Blob(["step_up_required"], { type: "text/plain" }))],
    ["an oversized Blob", httpError(403, new Blob([JSON.stringify({ ...STEP_UP, pad: "x".repeat(5000) })], { type: "application/json" }))],
    ["a garbled JSON Blob", httpError(403, new Blob(["{"], { type: "application/json" }))],
    ["an HTML body", httpError(403, "<html>step_up_required</html>")],
    ["a non-/api request", httpError(403, STEP_UP, "/console/api/x")],
    ["a non-axios error", new Error("step_up_required")],
  ])("ignores %s", async (_label, error) => {
    await expect(stepUpRedirectFor(error, at("/s/eng/p/abc"))).resolves.toBeNull();
  });

  it.each(["/share/abc/p/def", "/", "/request-access"])(
    "never redirects from the public or shared page %s",
    async (pathname) => {
      await expect(stepUpRedirectFor(httpError(403, STEP_UP), at(pathname))).resolves.toBeNull();
    },
  );
});

describe("stepUpConfirmHref", () => {
  it("encodes the return path", () => {
    expect(stepUpConfirmHref(at("/s/a%20b", "?q=1&r=2"))).toBe(
      `/console/confirm?return=${encodeURIComponent("/s/a%20b?q=1&r=2")}`,
    );
  });

  it.each(["//evil.example/x", "/\\evil.example"])(
    "returns home for an unsafe current path %s (never a protocol-relative return)",
    (pathname) => {
      expect(stepUpConfirmHref(at(pathname))).toBe(confirmFor("/home"));
    },
  );
});
