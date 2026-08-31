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
});
