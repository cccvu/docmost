import api from "@/lib/api-client";
import platformApi from "@/lib/platform-client";

export interface IPublicPage {
  pageId: string;
  slugId: string;
  title: string | null;
  icon: string | null;
  spaceName: string | null;
  spaceSlug: string | null;
  shareKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface IPublicPageList {
  items: IPublicPage[];
  meta: { hasNextPage: boolean; nextCursor: string | null };
}

/**
 * Anonymous discovery of explicitly-public pages. Backed by the fork's `@Public` endpoint
 * (`/api/public/pages/list`), which lists only owner-opted, non-restricted, sharing-enabled shares —
 * a strict subset of what is already served by the public share path. Uses the shared `/api` client;
 * the endpoint returns 200 for anonymous callers so the 401 interceptor never fires here.
 */
export async function getPublicContent(params?: {
  limit?: number;
  cursor?: string;
}): Promise<IPublicPageList> {
  const req = await api.post<IPublicPageList>(
    "/public/pages/list",
    params ?? {},
  );
  return req.data as IPublicPageList;
}

export interface IRequestAccessResponse {
  id: string;
  email: string;
  status: string;
  message: string;
}

// Passwordless: request access captures only an email (no password anywhere on the platform). The
// account is created `pending` and cannot sign in until an admin approves it.
export async function requestAccess(data: {
  email: string;
}): Promise<IRequestAccessResponse> {
  const res = await platformApi.post<IRequestAccessResponse>(
    "/auth/register",
    data,
  );
  return res.data;
}

export interface IPasswordlessRequestResponse {
  message: string;
}

// Ask the platform to email a magic link + OTP. The response is ALWAYS generic (account-enumeration
// resistance) — the UI shows the same "check your email" state regardless of whether an account exists.
export async function requestPasswordless(data: {
  email: string;
}): Promise<IPasswordlessRequestResponse> {
  const res = await platformApi.post<IPasswordlessRequestResponse>(
    "/auth/passwordless/request",
    data,
  );
  return res.data;
}

export interface IPasswordlessVerifyResponse {
  id: string;
  email: string;
  workspaceId: string;
}

// Verify EITHER a magic-link token OR an email + OTP. On success the platform sets the session cookie;
// the caller must then run openDocmostSession() before navigating (the two-step BFF bridge).
export async function verifyPasswordless(
  data: { token: string } | { email: string; otp: string },
): Promise<IPasswordlessVerifyResponse> {
  const res = await platformApi.post<IPasswordlessVerifyResponse>(
    "/auth/passwordless/verify",
    data,
  );
  return res.data;
}
