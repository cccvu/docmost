// CCC (fork-owned): client for the remote-mode public-share expiry API (#335, ADR 0032).
//
// The server (`authz/share-lifecycle/`) owns the policy: a share with no explicit choice expires 90 days
// after it was created, "Never" is an explicit opt-in, and every public read checks expiry in SQL. These
// calls only read and change that choice. Both routes 404 in native mode and for an expired/missing share.
import api from "@/lib/api-client";

/** The durations the server accepts. `null` = "Never". A choice is counted from now (renewal). */
export type ShareExpiryDays = 7 | 30 | 90 | 365 | null;

export interface IShareExpiry {
  /** ISO instant the share stops being publicly readable, or `null` when it never expires. */
  expiresAt: string | null;
}

export interface ISetShareExpiry {
  shareId: string;
  expiresInDays: ShareExpiryDays;
}

export async function getShareExpiry(shareId: string): Promise<IShareExpiry> {
  const req = await api.post<IShareExpiry>("/shares/expiry/info", { shareId });
  return req.data;
}

export async function setShareExpiry(
  data: ISetShareExpiry,
): Promise<IShareExpiry> {
  const req = await api.post<IShareExpiry>("/shares/expiry", data);
  return req.data;
}
