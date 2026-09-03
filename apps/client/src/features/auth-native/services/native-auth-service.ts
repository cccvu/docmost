import api from "@/lib/api-client";

export interface INativeLogin {
  email: string;
  password: string;
}

/**
 * CCC native (standalone) sign-in — NOT upstream Docmost code.
 *
 * Posts credentials to Docmost's OWN `/api/auth/login`, which verifies them and sets the httpOnly
 * `authToken` cookie server-side. Used ONLY in native mode; in remote mode these native credential
 * routes are disabled server-side (the platform passwordless flow signs in instead), so this transport
 * is never reachable there. MFA is EE-only and absent from the OSS fork, so a successful login here just
 * establishes the session.
 */
export async function nativeLogin(data: INativeLogin): Promise<void> {
  await api.post("/auth/login", data);
}
