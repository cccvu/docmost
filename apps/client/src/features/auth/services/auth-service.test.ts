import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock BOTH axios instances so we can assert exactly which surface each auth op targets.
// The bug in #46 was login/logout resolving to Docmost's ALB-blocked /api/auth/*; these tests
// pin them to the platform surface (/auth/*, /bff/*).
vi.mock("@/lib/platform-client", () => ({
  default: { post: vi.fn(async () => ({ data: {} })) },
}));
vi.mock("@/lib/api-client", () => ({
  default: { post: vi.fn(async () => ({ data: {} })) },
}));

import api from "@/lib/api-client";
import platformApi from "@/lib/platform-client";
import {
  logout,
  openDocmostSession,
} from "@/features/auth/services/auth-service";
import { requestAccess } from "@/features/public/services/public-service";

// NOTE: password login() was removed (passwordless — issue #4); its routing test is gone with it.
// The BFF exchange + logout routing (the load-bearing #46 seam) is still asserted below, and the
// passwordless request/verify routing is covered in features/public/services/public-service.test.ts.
describe("auth-service platform routing (issue #46)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("openDocmostSession() posts to the platform BFF /bff/docmost/session (no body)", async () => {
    await openDocmostSession();
    expect(platformApi.post).toHaveBeenCalledWith("/bff/docmost/session");
    expect(api.post).not.toHaveBeenCalled();
  });

  it("logout() clears BOTH the platform and the Docmost session", async () => {
    await logout();
    // Platform session (__Host-wiki_session) + Redis session revocation:
    expect(platformApi.post).toHaveBeenCalledWith("/auth/logout");
    // Docmost session (authToken) via the ALB-allowed native logout:
    expect(api.post).toHaveBeenCalledWith("/auth/logout");
  });

  it("logout() still clears the Docmost session when the platform logout fails (allSettled, not all)", async () => {
    // Exact scenario the code guards: an already-expired __Host-wiki_session → platform logout 401s.
    // With Promise.all this would reject and skip the Docmost leg; allSettled must not.
    (platformApi.post as any).mockRejectedValueOnce(new Error("expired session"));
    await expect(logout()).resolves.toBeUndefined(); // does not throw
    expect(api.post).toHaveBeenCalledWith("/auth/logout"); // Docmost still cleared
  });

  it("requestAccess() still targets the platform /auth/register (email-only, passwordless)", async () => {
    await requestAccess({ email: "new@vanderbilt.edu" });
    expect(platformApi.post).toHaveBeenCalledWith("/auth/register", {
      email: "new@vanderbilt.edu",
    });
  });

  // BOUNDARY INVARIANT (issue #46 Layer 1 — generalizes the per-op routing checks above). The ALB denies
  // /api/auth/* except `docmost_auth_allow_paths` (infra/terraform/locals.tf): collab-token + logout. The
  // stock `api` instance has baseURL "/api", so api.post("/auth/<x>") resolves to /api/auth/<x>; any
  // load-bearing auth op that lands on a NON-allow-listed path 403s in prod (exactly the #46 break). This
  // asserts that across the platform-owned session/registration ops, EVERY call made on the stock `api`
  // instance stays inside the ALB allow-list, and the platform-owned ops actually reach the platform
  // surface (/bff/*, /auth/*). Re-routing any of them back onto `api` toward a blocked path turns this red.
  it("keeps every stock-api auth call inside the ALB allow-list; session/registration ops hit the platform", async () => {
    // Paths resolved on the `api` (/api-prefixed) instance that the ALB allows through to Docmost:
    const ALB_ALLOWLISTED = new Set(["/auth/logout", "/auth/collab-token"]);

    await openDocmostSession();
    await logout();
    await requestAccess({ email: "x@vanderbilt.edu" });

    // No platform-owned op may hit an ALB-blocked /api/auth/* path:
    for (const call of (api.post as any).mock.calls) {
      expect(ALB_ALLOWLISTED.has(call[0])).toBe(true);
    }
    // ...and the session/registration ops must actually reach the platform surface:
    expect(platformApi.post).toHaveBeenCalledWith("/bff/docmost/session");
    expect(platformApi.post).toHaveBeenCalledWith("/auth/register", {
      email: "x@vanderbilt.edu",
    });
  });
});
