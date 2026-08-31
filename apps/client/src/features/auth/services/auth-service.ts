import api from "@/lib/api-client";
import platformApi from "@/lib/platform-client";
import {
  IChangePassword,
  ICollabToken,
  IForgotPassword,
  ILogin,
  IPasswordReset,
  ISetupWorkspace,
  IVerifyUserToken,
} from "@/features/auth/types/auth.types";
import { IWorkspace } from "@/features/workspace/types/workspace.types.ts";

// The CCC platform's login response. `id`/`email`/`workspaceId` are what the platform actually
// returns; the MFA fields are NOT part of the platform contract today (the platform has no MFA).
// They stay optional as forward-compat so the shared handleSignIn MFA branch — dead on this path —
// remains type-safe.
export interface IPlatformLoginResponse {
  id: string;
  email: string;
  workspaceId: string;
  userHasMfa?: boolean;
  requiresMfaSetup?: boolean;
}

// Login is owned by the CCC platform, not Docmost. It must hit the platform's `/auth/login`
// (routed to the platform target group), NOT Docmost's `/api/auth/login`, which the ALB blocks.
//
// INVARIANT: a non-MFA platform login only HALF-authenticates the browser — it sets the platform
// session but not Docmost's. A successful non-MFA login MUST be followed by openDocmostSession()
// before any Docmost `/api/*` request (see handleSignIn in use-auth.ts). login() alone returns 200
// at the platform but leaves every `/api/*` call 401ing.
export async function login(data: ILogin): Promise<IPlatformLoginResponse> {
  const res = await platformApi.post<IPlatformLoginResponse>("/auth/login", data);
  return res.data;
}

// After a platform login, exchange the platform session for a Docmost session: the platform BFF
// provisions/looks up the Docmost shadow user, performs a server-to-server Docmost login, and relays
// Docmost's native `authToken` cookie to the browser. Without this, every Docmost `/api/*` call 401s
// even after a successful platform login (the platform and Docmost sign with separate keys).
export async function openDocmostSession(): Promise<void> {
  await platformApi.post("/bff/docmost/session");
}

export async function logout(): Promise<void> {
  // End BOTH sessions: the platform session (primary identity, `__Host-wiki_session`) and the relayed
  // Docmost session (`authToken`). Both are same-origin and ALB-allowed. allSettled so one failing
  // (e.g. an already-expired cookie) never blocks clearing the other.
  await Promise.allSettled([
    platformApi.post("/auth/logout"),
    api.post<void>("/auth/logout"),
  ]);
}

export async function changePassword(
  data: IChangePassword,
): Promise<IChangePassword> {
  const req = await api.post<IChangePassword>("/auth/change-password", data);
  return req.data;
}

export async function setupWorkspace(
  data: ISetupWorkspace,
): Promise<IWorkspace> {
  const req = await api.post<IWorkspace>("/auth/setup", data);
  return req.data;
}

export async function forgotPassword(data: IForgotPassword): Promise<void> {
  await api.post<void>("/auth/forgot-password", data);
}

export async function passwordReset(data: IPasswordReset): Promise<{ requiresLogin?: boolean; }> {
  const req = await api.post("/auth/password-reset", data);
  return req.data;
}

export async function verifyUserToken(data: IVerifyUserToken): Promise<any> {
  return api.post<any>("/auth/verify-token", data);
}

export async function getCollabToken(): Promise<ICollabToken> {
  const req = await api.post<ICollabToken>("/auth/collab-token");
  return req.data;
}

