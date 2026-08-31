import axios from "axios";

/**
 * Axios instance for the CCC platform surface — identity (`/auth/*`) and the BFF (`/bff/*`) —
 * which is a SEPARATE service from Docmost. The edge serves it same-origin: the ALB routes
 * `/auth/*` and `/bff/*` to the platform target group in prod, and a Vite proxy forwards them
 * to the platform in dev (see vite.config.ts). Paths are root-relative so one instance covers
 * both prefixes.
 *
 * Deliberately has NO interceptors — unlike the `/api` client (api-client.ts), a platform-auth
 * 401 must never trigger the redirect-to-login, and platform responses are NOT wrapped in
 * Docmost's `{data,success,status}` envelope, so callers read `res.data` directly.
 *
 * GUARDRAIL: only ever pass ROOT-RELATIVE, same-origin paths (`/auth/*`, `/bff/*`). Because
 * `withCredentials` is on, passing an absolute URL would send the session cookie cross-origin.
 */
const platformApi = axios.create({ withCredentials: true });

export default platformApi;
