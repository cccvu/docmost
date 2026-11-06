import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #310 self-heal: in remote mode a Docmost 401 (stale/absent session cookie, e.g. right after the
 * `__Host-authToken` rename deploy) must re-mint the Docmost session ONCE and retry — not bounce an
 * authenticated user (whose platform `__Host-wiki_session` is still valid) to /login. Loop-guarded; skipped
 * in native mode and on public routes. Driven end-to-end through the real interceptor via a mock adapter.
 */

// vi.mock factories are hoisted above imports/consts, so the mock fns must come from vi.hoisted().
const { openDocmostSession, isNativeAuthEnabled, isPublicRoutePath } = vi.hoisted(
  () => ({
    openDocmostSession: vi.fn(async () => {}),
    isNativeAuthEnabled: vi.fn(() => false),
    isPublicRoutePath: vi.fn(() => false),
  }),
);
vi.mock("@/features/auth/services/auth-service.ts", () => ({ openDocmostSession }));
vi.mock("@/features/auth-native/lib/auth-mode.ts", () => ({ isNativeAuthEnabled }));
vi.mock("@/lib/app-route.ts", () => ({
  default: {
    AUTH: {
      LOGIN: "/login",
      SIGNUP: "/signup",
      MFA_CHALLENGE: "/mfa",
      MFA_SETUP_REQUIRED: "/mfa-setup",
      SETUP: "/setup/register",
    },
    HOME: "/",
  },
  isPublicRoutePath,
  // #713: the step-up helper validates its return path with this; same-origin paths only, as the real one.
  safeRedirectPath: (p: string) => (p.startsWith("/") && !p.startsWith("//") ? p : null),
}));
vi.mock("@/lib/config.ts", () => ({ isCloud: () => false }));

import { AxiosError } from "axios";
import api from "@/lib/api-client";

const RESP_URL = "https://wiki.example/api/pages/info";
const originalAdapter = api.defaults.adapter;

// axios's `adapter` type is AxiosAdapterConfig; our stub returns a bare response/throws, so cast at the seam.
function setAdapter(fn: (config: any) => Promise<any>) {
  api.defaults.adapter = fn as unknown as typeof api.defaults.adapter;
}

function ok(config: any) {
  return {
    data: { ok: true },
    status: 200,
    statusText: "OK",
    headers: {},
    config,
    request: { responseURL: RESP_URL },
  };
}
function unauthorized(config: any) {
  const err: any = new Error("Unauthorized");
  err.config = config;
  err.request = { responseURL: RESP_URL };
  err.response = { status: 401, data: {} };
  throw err;
}

describe("api-client 401 self-heal (#310)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isNativeAuthEnabled.mockReturnValue(false);
    isPublicRoutePath.mockReturnValue(false);
    Object.defineProperty(window, "location", {
      value: { pathname: "/home", href: "" },
      writable: true,
      configurable: true,
    });
  });
  afterEach(() => {
    api.defaults.adapter = originalAdapter;
  });

  it("remote mode: re-mints ONCE and retries, returning the retried result (no redirect)", async () => {
    let calls = 0;
    setAdapter(async (config) => {
      calls += 1;
      return calls === 1 ? unauthorized(config) : ok(config);
    });

    const result = await api.get("/pages/info");

    expect(openDocmostSession).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2); // original + one retry
    expect(result).toEqual({ ok: true });
    expect(window.location.href).toBe(""); // never redirected
  });

  it("loop-guard: a persistent 401 re-mints only ONCE, then falls to the login wall", async () => {
    let calls = 0;
    setAdapter(async (config) => {
      calls += 1;
      return unauthorized(config);
    });

    await expect(api.get("/pages/info")).rejects.toBeTruthy();

    expect(openDocmostSession).toHaveBeenCalledTimes(1); // not repeated
    expect(calls).toBe(2); // original + one retry, then no more
    expect(window.location.href).toContain("/login");
  });

  it("re-mint failure: openDocmostSession rejects → one attempt, no retry, falls to the login wall", async () => {
    // The self-heal `catch` (api-client.ts): when the re-mint itself throws/401s (the platform session is
    // truly gone), swallow it and hit the login wall — never retry the original request. Without the
    // try/catch the rejection would propagate and `redirectToLogin()` would never fire, so this pins it.
    openDocmostSession.mockRejectedValueOnce(new Error("re-mint failed"));
    let calls = 0;
    setAdapter(async (config) => {
      calls += 1;
      return unauthorized(config);
    });

    await expect(api.get("/pages/info")).rejects.toBeTruthy();

    expect(openDocmostSession).toHaveBeenCalledTimes(1); // attempted exactly once
    expect(calls).toBe(1); // the re-mint threw BEFORE `return api(config)`, so the original ran only once
    expect(window.location.href).toContain("/login"); // fell through to the wall (the catch path)
  });

  it("native mode: never re-mints (there is no platform session to lean on)", async () => {
    isNativeAuthEnabled.mockReturnValue(true);
    let calls = 0;
    setAdapter(async (config) => {
      calls += 1;
      return unauthorized(config);
    });

    await expect(api.get("/pages/info")).rejects.toBeTruthy();

    expect(openDocmostSession).not.toHaveBeenCalled();
    expect(calls).toBe(1); // no retry
    expect(window.location.href).toContain("/login");
  });

  it("public route: never re-mints and never hard-redirects", async () => {
    isPublicRoutePath.mockReturnValue(true);
    setAdapter(async (config) => unauthorized(config));

    await expect(api.get("/users/me")).rejects.toBeTruthy();

    expect(openDocmostSession).not.toHaveBeenCalled();
    expect(window.location.href).toBe(""); // public experience renders; no /login bounce
  });
});

/**
 * #384: the 404 branch read `data.message.toLowerCase()` unguarded, so a 404 with no message, an array
 * message (validation shape) or an HTML body threw a TypeError out of the interceptor and the caller saw that
 * instead of the real AxiosError (and its status).
 */
describe("api-client 404 handling (#384)", () => {
  function notFound(data: unknown) {
    return async (config: any) => {
      throw new AxiosError("Request failed with status code 404", "ERR_BAD_REQUEST", config, {
        responseURL: RESP_URL,
      }, {
        status: 404,
        statusText: "Not Found",
        data,
        headers: {},
        config,
      });
    };
  }

  beforeEach(() => {
    Object.defineProperty(window, "location", {
      value: { pathname: "/home", href: "" },
      writable: true,
      configurable: true,
    });
  });
  afterEach(() => {
    api.defaults.adapter = originalAdapter;
  });

  it.each([
    ["no message", {}],
    ["no body", undefined],
    ["an array message", { message: ["id must be a UUID"] }],
    ["an HTML string body", "<html><body>Not Found</body></html>"],
  ])("a 404 with %s rejects with the original AxiosError", async (_name, data) => {
    setAdapter(notFound(data));

    const error = await api.get("/pages/info").catch((e) => e);

    expect(error).toBeInstanceOf(AxiosError);
    expect(error.response.status).toBe(404);
    expect(window.location.href).toBe("");
  });

  it("'workspace not found' still sends a self-hosted install to setup", async () => {
    setAdapter(notFound({ message: "Workspace not found" }));

    const error = await api.get("/pages/info").catch((e) => e);

    expect(error).toBeInstanceOf(AxiosError);
    expect(window.location.href).toBe("/setup/register");
  });
});

/**
 * wiki-v2 #713: the engine answers a sensitive action on a not-recently-signed-in session with
 * `403 {code: "step_up_required"}`. The interceptor sends the browser to the console confirm page (which re-mints the
 * session fresh and returns), never re-mints itself (a re-mint from the same platform session is just as stale), and
 * still rejects with the original error so the caller's own error handling runs.
 */
describe("api-client 403 step-up (#713)", () => {
  const assign = vi.fn();
  function forbidden(data: unknown) {
    return async (config: any) => {
      throw new AxiosError("Request failed with status code 403", "ERR_BAD_REQUEST", config, {
        responseURL: "https://wiki.example/api/pages/delete",
      }, {
        status: 403,
        statusText: "Forbidden",
        data,
        headers: {},
        config,
      });
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    isPublicRoutePath.mockReturnValue(false);
    Object.defineProperty(window, "location", {
      value: { pathname: "/s/eng/p/abc", search: "?x=1", href: "", assign },
      writable: true,
      configurable: true,
    });
  });
  afterEach(() => {
    api.defaults.adapter = originalAdapter;
  });

  it("step_up_required: navigates to /console/confirm with the current path, and still rejects", async () => {
    setAdapter(forbidden({ message: "Recent sign-in required", code: "step_up_required" }));

    const error = await api.post("/pages/delete", { pageId: "p", permanentlyDelete: true }).catch((e) => e);

    expect(error).toBeInstanceOf(AxiosError);
    expect(error.response.status).toBe(403);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(`/console/confirm?return=${encodeURIComponent("/s/eng/p/abc?x=1")}`);
    expect(openDocmostSession).not.toHaveBeenCalled();
  });

  it("a plain 403 (a permission deny) does not navigate", async () => {
    setAdapter(forbidden({ message: "Forbidden", statusCode: 403 }));

    const error = await api.post("/pages/delete", {}).catch((e) => e);

    expect(error).toBeInstanceOf(AxiosError);
    expect(assign).not.toHaveBeenCalled();
    expect(window.location.href).toBe("");
  });

  it("a public route never navigates", async () => {
    isPublicRoutePath.mockReturnValue(true);
    setAdapter(forbidden({ code: "step_up_required" }));

    await expect(api.post("/pages/delete", {})).rejects.toBeInstanceOf(AxiosError);
    expect(assign).not.toHaveBeenCalled();
  });
});
