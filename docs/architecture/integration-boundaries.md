# Integration boundaries

This fork is designed so the AGPL Docmost engine and any proprietary integration (such as the CCC platform)
stay cleanly separated: the fork runs independently, and an integration is an opt-in network relationship
over published contracts, not a code entanglement.

## The mode is a security boundary

`AUTHZ_MODE` selects who decides authorization:

| Mode | Authorization decided by | Native credential login | External services contacted |
| --- | --- | --- | --- |
| `native` | Docmost's own CASL + ACL tables | enabled | none |
| `remote` | an external authorization service (the contract in [`../integrations/authorization/`](../integrations/authorization/)) | disabled server-side | authorization + audit |

Rules that a future change must not break:

1. **Explicit and validated at boot.** `AUTHZ_MODE` is required, must be exactly `native` or `remote`, and is
   never inferred from availability, request content, headers, cookies, URLs, or client state.
2. **No runtime switch.** The mode is fixed for the life of the process; changing it requires a redeploy.
3. **No downgrade fallback.** In `remote` mode an unreachable or failing authorization service results in
   deny/empty (fail-closed), never a fall back to native decisions. Falling back would grant whatever the
   local mirror allows, which the external service may have revoked.
4. **`remote` disables native credentials for ALL callers.** The native credential routes return 404 in
   remote mode even to a caller presenting the service secret; sessions are minted only through the service
   bridge (see below).
5. **Native mode is a real control, never allow-all.** It is Docmost's own authorization, fully enforced.

The client is told a *capability* (`NATIVE_AUTH_ENABLED`), never the raw mode, so the UI picks which login to
render without coupling to the deployment's security architecture.

## Where the code lives

All CCC integration logic is first-class, fork-owned, and kept out of upstream Docmost files:

- `apps/server/src/authz/` — the authorization integration: the mode selector (`authz/mode/`), the
  implementation-neutral ports (`authz/port/`), the PDP-backed repo subclasses used in remote mode, the
  audit forwarder, the search subclass, and the route guard.
- `apps/server/src/service-bridge/` — the east-west endpoints the fork exposes to an integrating platform
  (session brokerage and shadow-user provisioning). This is authentication/session, not authorization.
- `apps/client/src/features/auth-native/` — the native sign-in UI, rendered only when native auth is enabled.

Upstream-owned files are modified only at narrow, documented seams (DI registration, a boot validator, a
capability injection, a guard mount). The seams are enumerated in the super-repo's `UPSTREAM_MODIFICATIONS.md`
and enforced by a boundary check, so upstream upgrades stay a merge-and-go.

## The two contract directions

An integration talks to the fork over two documented contracts (both under
[`../integrations/authorization/`](../integrations/authorization/)):

- **Outbound** (`authorization-service.openapi.json`): what the fork CALLS in remote mode. A third party
  implements this to be the authorization + audit service.
- **Inbound** (`service-bridge.openapi.json`): what the fork EXPOSES. An integrating platform calls these to
  provision a shadow user and mint a session, and to force-disconnect a live collab session.

Because both directions are published contracts, an integrator never needs the fork's proprietary counterpart
source, and the fork never needs the integrator's.
