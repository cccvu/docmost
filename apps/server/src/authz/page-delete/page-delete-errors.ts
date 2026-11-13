import { ConflictException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { toPageGuardConflict } from '../../service-bridge/page-guard-conflict.interceptor';
import { RESTRICTION_STRIP } from '../../service-bridge/page-restriction-guard.installer';

/**
 * CCC authorization integration — NOT upstream Docmost code (#636 W6, #661, #618, #589, #556).
 *
 * The refusals of the remote page lifecycle routines (removal, and the restore). Every one means NOTHING changed. The messages are fixed texts:
 * they name no page, space or principal and carry no count, so a refusal never discloses what the caller could not
 * see. The `code` is what the platform maps to its own problem type.
 */

/** Upstream's purge refusal (space CASL `Manage Settings`), reused verbatim for the PDP's `space#administer`. */
export const SPACE_ADMIN_REQUIRED = 'Only space admins can permanently delete pages';

export function spaceAdminRequired(): ForbiddenException {
  return new ForbiddenException(SPACE_ADMIN_REQUIRED);
}

export function purgeNeedsEdit(): ForbiddenException {
  return new ForbiddenException({
    message: 'a permanent delete needs edit access to every page it removes',
    code: 'purge_needs_edit',
  });
}

/** 503, retryable: the purge could not establish its authorization (fence unconfirmed, PDP unreachable). */
export function purgeUnconfirmed(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    message: 'access changes could not be confirmed as enforced; nothing was deleted — retry shortly',
    code: 'purge_unconfirmed',
  });
}

/** 409, retryable: the subtree kept changing under the purge. */
export function purgeSubtreeChanged(): ConflictException {
  return new ConflictException({
    message: 'the page tree changed while it was being deleted; nothing was deleted — retry',
    code: 'purge_subtree_changed',
  });
}

/** 403: a trash needs edit access to every page it trashes (the human's, and any delegated service account's). */
export function trashNeedsEdit(): ForbiddenException {
  return new ForbiddenException({
    message: 'moving a page to the trash needs edit access to it and to every sub-page it moves',
    code: 'trash_needs_edit',
  });
}

/** 503, retryable: the trash could not establish its authorization (fence unconfirmed, PDP unreachable). */
export function trashUnconfirmed(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    message: 'access changes could not be confirmed as enforced; nothing was moved to the trash — retry shortly',
    code: 'trash_unconfirmed',
  });
}

/** 409, retryable: the subtree changed under the trash. */
export function trashSubtreeChanged(): ConflictException {
  return new ConflictException({
    message: 'the page tree changed while it was being moved to the trash; nothing was moved — retry',
    code: 'trash_subtree_changed',
  });
}

/** 409: an archived space is frozen against irreversible removal (#589). Trash and restore stay allowed. */
export function spaceArchived(): ConflictException {
  return new ConflictException({
    message: 'pages in an archived space cannot be permanently deleted; restore the space first',
    code: 'space_archived',
  });
}

/** 403: a restore needs edit access to every page it brings back (the human's, and any delegated service account's). */
export function restoreNeedsEdit(): ForbiddenException {
  return new ForbiddenException({
    message: 'restoring a page needs edit access to it and to every sub-page trashed with it; nothing was restored',
    code: 'restore_needs_edit',
  });
}

/** 503, retryable: the restore could not establish its authorization (fence unconfirmed, PDP unreachable). */
export function restoreUnconfirmed(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    message: 'access changes could not be confirmed as enforced; nothing was restored — retry shortly',
    code: 'restore_unconfirmed',
  });
}

/** What a person is told when the #545 g2 guard refuses a restore's detach (the move wording does not fit). */
export const RESTORE_RESTRICTION_STRIP_MESSAGE =
  'Restoring this page would take it out of its restricted section, so nothing was restored. Restore the page it was under first.';

/**
 * The 409 for a page-guard refusal of a restore, or null for any other error. The interceptor that maps the guards for
 * the native handler (`PageGuardConflictInterceptor`) never runs here — the restore routine replaces the handler — so
 * the routine maps them itself: g2 (`ccc_page_restriction_strip`) keeps its code, which the platform already maps, with
 * a restore-specific text; any other guard keeps `toPageGuardConflict`'s answer.
 */
export function restoreGuardConflict(err: unknown): ConflictException | null {
  const mapped = toPageGuardConflict(err);
  if (!mapped) return null;
  return (err as { constraint_name?: unknown }).constraint_name === RESTRICTION_STRIP
    ? new ConflictException({ message: RESTORE_RESTRICTION_STRIP_MESSAGE, code: RESTRICTION_STRIP })
    : mapped;
}
