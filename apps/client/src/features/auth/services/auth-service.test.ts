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
  login,
  logout,
  openDocmostSession,
} from "@/features/auth/services/auth-service";
import { requestAccess } from "@/features/public/services/public-service";

describe("auth-service platform routing (issue #46)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("login() posts to the platform /auth/login, never Docmost /api/auth/login", async () => {
    await login({ email: "cccadmin@vanderbilt.edu", password: "pw" });
    expect(platformApi.post).toHaveBeenCalledWith("/auth/login", {
      email: "cccadmin@vanderbilt.edu",
      password: "pw",
    });
    // The stock /api client (baseURL "/api") must NOT be used — that path is ALB-403-blocked.
    expect(api.post).not.toHaveBeenCalled();
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

  it("requestAccess() still targets the platform /auth/register (guards the client consolidation)", async () => {
    await requestAccess({
      email: "new@vanderbilt.edu",
      password: "a-long-enough-password",
    });
    expect(platformApi.post).toHaveBeenCalledWith("/auth/register", {
      email: "new@vanderbilt.edu",
      password: "a-long-enough-password",
    });
  });
});
