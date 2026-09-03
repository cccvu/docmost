/**
 * CCC service-bridge — NOT upstream Docmost code.
 *
 * Scopes for the east-west `/api/service/*` machine-to-machine endpoints. Each route declares the single
 * scope it needs; the ServiceAuthGuard authorizes THAT scope (least privilege), not mere secret
 * possession. Today one shared secret is a transitional credential granted the full set; distinct
 * per-scope credentials can be introduced later with no guard redesign.
 */
export enum ServiceScope {
  SessionMint = 'session:mint',
  UsersProvision = 'users:provision',
}
