import axios from "axios";
import api from "@/lib/api-client";

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

// The platform's gated registration lives behind /auth on a SEPARATE service. Use an isolated axios
// instance WITHOUT the /api 401 interceptor, so a request-access failure can never bounce the visitor
// to /login. In dev a Vite proxy forwards /auth to the platform; in a deployed edge topology the
// platform serves /auth same-origin. Isolated here so the transport is a one-line change / graceful
// degrade if the topology isn't wired.
const platformApi = axios.create({ baseURL: "/auth", withCredentials: true });

export interface IRequestAccessResponse {
  id: string;
  email: string;
  status: string;
  message: string;
}

export async function requestAccess(data: {
  email: string;
  password: string;
}): Promise<IRequestAccessResponse> {
  const res = await platformApi.post<IRequestAccessResponse>(
    "/register",
    data,
  );
  return res.data;
}
