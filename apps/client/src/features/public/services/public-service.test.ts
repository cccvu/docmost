import { beforeEach, describe, expect, it, vi } from "vitest";

// Same #46 bug class: a passwordless call resolving to Docmost's ALB-blocked /api/auth/* instead of the
// platform surface would 403 in prod. Pin request/verify to the platform client (/auth/passwordless/*).
vi.mock("@/lib/platform-client", () => ({
  default: { post: vi.fn(async () => ({ data: {} })) },
}));
vi.mock("@/lib/api-client", () => ({
  default: { post: vi.fn(async () => ({ data: {} })) },
}));

import api from "@/lib/api-client";
import platformApi from "@/lib/platform-client";
import {
  requestAccess,
  requestPasswordless,
  verifyPasswordless,
} from "./public-service";

describe("public-service passwordless routing", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requestPasswordless() posts to the platform /auth/passwordless/request", async () => {
    await requestPasswordless({ email: "user@vanderbilt.edu" });
    expect(platformApi.post).toHaveBeenCalledWith("/auth/passwordless/request", {
      email: "user@vanderbilt.edu",
    });
    expect(api.post).not.toHaveBeenCalled(); // never the ALB-blocked Docmost /api client
  });

  it("verifyPasswordless() posts an OTP to the platform /auth/passwordless/verify", async () => {
    await verifyPasswordless({ email: "user@vanderbilt.edu", otp: "482913" });
    expect(platformApi.post).toHaveBeenCalledWith("/auth/passwordless/verify", {
      email: "user@vanderbilt.edu",
      otp: "482913",
    });
    expect(api.post).not.toHaveBeenCalled();
  });

  it("verifyPasswordless() posts a magic-link token to the platform /auth/passwordless/verify", async () => {
    await verifyPasswordless({ token: "raw-link-token" });
    expect(platformApi.post).toHaveBeenCalledWith("/auth/passwordless/verify", {
      token: "raw-link-token",
    });
  });

  it("requestAccess() targets the platform /auth/register (email-only, passwordless)", async () => {
    await requestAccess({ email: "new@vanderbilt.edu" });
    expect(platformApi.post).toHaveBeenCalledWith("/auth/register", {
      email: "new@vanderbilt.edu",
    });
  });
});
