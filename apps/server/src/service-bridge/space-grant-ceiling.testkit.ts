import { SpaceGrantCeiling } from './space-grant-ceiling';

/**
 * A `SpaceGrantCeiling` stand-in that covers every raise (an actor who holds everything), for the specs of the member
 * writes that are NOT about INV-2 (rule M, last-admin, versions, the wire). INV-2 itself is proven against the real
 * class (`space-grant-ceiling.spec.ts`, `space-grant-ceiling.pg.spec.ts`).
 *
 * NOT a jest suite: the `.testkit.ts` suffix keeps it out of the runtime image and out of the jest testRegex.
 */
export const allowAllCeiling = (): SpaceGrantCeiling =>
  ({
    assertCovers: jest.fn(async () => undefined),
    fence: jest.fn(async () => undefined),
  }) as unknown as SpaceGrantCeiling;
