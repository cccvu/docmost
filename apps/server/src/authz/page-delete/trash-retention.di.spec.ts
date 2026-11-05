import { Test } from '@nestjs/testing';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { getQueueToken } from '@nestjs/bullmq';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';

// PageService's module graph pulls in the collab WebSocket stack (lib0 ESM) that jest cannot parse. Stub it.
jest.mock('../../collaboration/collaboration.gateway', () => ({ CollaborationGateway: class {} }));

import { TrashCleanupService } from '../../core/page/services/trash-cleanup.service';
import { PageService } from '../../core/page/services/page.service';
import { QueueName } from '../../integrations/queue/constants';
import { AUTHZ_MODE, AuthzMode } from '../mode/authz-mode';
import { RemoteTrashRetentionService } from './remote-trash-retention.service';
import { trashCleanupProvider } from './trash-retention.provider';

/**
 * #589 — the trash retention's DI and scheduling, through the real `@nestjs/schedule` explorer and orchestrator:
 * under the `TrashCleanupService` token, `trashCleanupProvider` (seam #183) yields the CCC retention in remote mode and
 * upstream's class in native mode, and in either mode the SchedulerRegistry holds exactly ONE `'trash-cleanup'`
 * interval, which runs that mode's `cleanupOldTrash` and never the other's (red-team F7: a subclass, or both classes
 * registered, would run upstream's unlocked purge too — or crash boot on the duplicate name).
 */
/** Spy on a prototype method, keeping the decorator metadata (`@Interval`) the schedule explorer reads off the function. */
function spyKeepingMetadata(proto: object, name: string): jest.SpyInstance {
  const original = (proto as Record<string, unknown>)[name] as object;
  const spy = jest.spyOn(proto as Record<string, () => Promise<void>>, name).mockResolvedValue(undefined);
  const replaced = (proto as Record<string, unknown>)[name] as object;
  for (const key of Reflect.getMetadataKeys(original)) {
    Reflect.defineMetadata(key, Reflect.getMetadata(key, original), replaced);
  }
  return spy;
}

describe('trash retention DI: one `trash-cleanup` interval, bound to the mode’s class', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it.each([
    ['remote', RemoteTrashRetentionService, TrashCleanupService],
    ['native', TrashCleanupService, RemoteTrashRetentionService],
  ] as const)('%s → %p, and only its cleanupOldTrash fires', async (mode, expected, other) => {
    jest.useFakeTimers();
    const ran = spyKeepingMetadata(expected.prototype, 'cleanupOldTrash');
    const notRan = spyKeepingMetadata(other.prototype, 'cleanupOldTrash');

    const moduleRef = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [
        trashCleanupProvider,
        { provide: AUTHZ_MODE, useValue: mode as AuthzMode },
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: {} },
        { provide: getQueueToken(QueueName.ATTACHMENT_QUEUE), useValue: {} },
        { provide: PageService, useValue: {} },
      ],
    }).compile();
    await moduleRef.init();
    try {
      expect(moduleRef.get(TrashCleanupService)).toBeInstanceOf(expected);
      expect(moduleRef.get(SchedulerRegistry).getIntervals()).toEqual(['trash-cleanup']);
      expect(moduleRef.get(SchedulerRegistry).getCronJobs().size).toBe(0);
      expect(moduleRef.get(SchedulerRegistry).getTimeouts()).toEqual([]);

      jest.advanceTimersByTime(24 * 60 * 60 * 1000);
      expect(ran).toHaveBeenCalledTimes(1);
      expect(notRan).not.toHaveBeenCalled();
    } finally {
      await moduleRef.close();
    }
  });
});
