import { describe, expect, it } from "vitest";
// NOTE: import the REAL instance (do not vi.mock it here). #46 was fundamentally a wrong-baseURL
// bug (`/api` prefix → ALB 403); this pins the transport config the fix depends on, which the
// module-mocked routing tests can't see.
import platformApi from "@/lib/platform-client";

describe("platform-client transport config (issue #46)", () => {
  it("is root-relative (no /api baseURL) so /auth/* and /bff/* resolve to the platform surface", () => {
    // A `/api` baseURL would send login back to Docmost's ALB-blocked path — the original bug.
    expect(platformApi.defaults.baseURL).toBeUndefined();
  });

  it("sends credentials so the platform session + relayed Docmost cookie ride the requests", () => {
    expect(platformApi.defaults.withCredentials).toBe(true);
  });
});
