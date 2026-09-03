import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api-client", () => ({
  default: { post: vi.fn(async () => ({ data: {} })) },
}));

import api from "@/lib/api-client";
import { nativeLogin } from "./native-auth-service";

describe("nativeLogin (native standalone sign-in)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("posts credentials to Docmost's own /auth/login on the stock api instance", async () => {
    await nativeLogin({ email: "admin@example.com", password: "pw" });
    expect(api.post).toHaveBeenCalledWith("/auth/login", {
      email: "admin@example.com",
      password: "pw",
    });
  });
});
