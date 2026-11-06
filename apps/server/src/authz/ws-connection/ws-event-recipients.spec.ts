import { InternalServerErrorException, Logger } from '@nestjs/common';
import { authzUnavailable } from '../authz-unavailable';
import { pageEventRecipients } from './ws-event-recipients';

/**
 * #716: a realtime page event's recipients. The comment paths emit fire-and-forget, so a PDP outage (now a 503 from the
 * repo) must send the event to no one and log it, not escape as an UnhandledRejection. Nothing else degrades.
 */
const PAGE = '0198c2a1-0000-7000-8000-0000000000aa';
const repo = (impl: () => Promise<string[]>) => ({ getUserIdsWithPageAccess: jest.fn(impl) });

describe('pageEventRecipients (#716)', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('healthy: the PDP answer, unchanged, and no log', async () => {
    const r = repo(async () => ['u1']);
    await expect(pageEventRecipients(r, PAGE, ['u1', 'u2'])).resolves.toEqual(['u1']);
    expect(r.getUserIdsWithPageAccess).toHaveBeenCalledWith(PAGE, ['u1', 'u2']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('the PDP could not answer: no recipients (never more), and one WS_EVENT_DROPPED line', async () => {
    const r = repo(async () => {
      throw authzUnavailable();
    });
    await expect(pageEventRecipients(r, PAGE, ['u1', 'u2'])).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(new RegExp(`^WS_EVENT_DROPPED page=${PAGE} candidates=2\\b`));
  });

  it('any other error is rethrown (only an outage degrades)', async () => {
    for (const e of [new InternalServerErrorException(), new Error('bug')]) {
      await expect(
        pageEventRecipients(
          repo(async () => {
            throw e;
          }),
          PAGE,
          ['u1'],
        ),
      ).rejects.toBe(e);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('ws.service.ts routes its recipients through this helper (the seam is wired)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const src = require('fs').readFileSync(require('path').join(__dirname, '../../ws/ws.service.ts'), 'utf8');
    expect(src).toMatch(/pageEventRecipients\(\s*this\.pagePermissionRepo,\s*pageId,\s*candidateUserIds,?\s*\)/);
    expect(src).not.toMatch(/this\.pagePermissionRepo\.getUserIdsWithPageAccess\(/);
  });
});
