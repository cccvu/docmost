import { PageEditMode } from "@/features/user/types/user.types.ts";

// CCC (#6): the page open-mode precedence, as a pure, unit-tested function.
//
//   explicit user preference > workspace default > Read system fallback
//
// Read is the safe fallback for any user/workspace without an explicit choice —
// pages open read-only to prevent accidental edits. A user who deliberately chose
// Edit keeps Edit; otherwise the admin's workspace default (managed in the console)
// applies; otherwise Read.
export function resolvePageEditMode(
  userPref: string | null | undefined,
  workspaceDefault: string | null | undefined,
): PageEditMode {
  if (userPref === PageEditMode.Edit || userPref === PageEditMode.Read) {
    return userPref;
  }
  if (
    workspaceDefault === PageEditMode.Edit ||
    workspaceDefault === PageEditMode.Read
  ) {
    return workspaceDefault;
  }
  return PageEditMode.Read;
}
