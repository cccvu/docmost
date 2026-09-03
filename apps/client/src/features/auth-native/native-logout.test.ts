import { beforeEach, describe, expect, it, vi } from "vitest";

// Force native mode so we exercise the standalone logout branch of the (upstream-seam) auth-service.
vi.mock("@/features/auth-native/lib/auth-mode.ts", () => ({
  isNativeAuthEnabled: () => true,
}));
vi.mock("@/lib/platform-client", () => ({
  default: { post: vi.fn(async () => ({ data: {} })) },
}));
vi.mock("@/lib/api-client", () => ({
  default: { post: vi.fn(async () => ({ data: {} })) },
}));

import api from "@/lib/api-client";
import platformApi from "@/lib/platform-client";
import { logout } from "@/features/auth/services/auth-service";

// Complements the remote-mode logout test (auth/services/auth-service.test.ts, which clears BOTH
// sessions): in native mode there is no platform session, so logout must clear ONLY Docmost's — hitting
// the platform surface would call a service that isn't running.
describe("logout() in native (standalone) mode", () => {
  beforeEach(() => vi.clearAllMocks());

  it("clears ONLY the Docmost session; never touches the platform", async () => {
    await logout();
    expect(api.post).toHaveBeenCalledWith("/auth/logout");
    expect(platformApi.post).not.toHaveBeenCalled();
  });
});
