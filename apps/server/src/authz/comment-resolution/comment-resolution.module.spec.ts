import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';

// The real CollaborationModule boots Hocuspocus and drags in lib0 ESM, which jest cannot parse. Stand in a
// module that exports the gateway token, exactly the one thing CommentResolutionModule takes from it.
jest.mock('../../collaboration/collaboration.gateway', () => ({
  CollaborationGateway: class CollaborationGateway {},
}));
jest.mock('../../collaboration/collaboration.module', () => {
  const { Module: NestModule } = jest.requireActual('@nestjs/common');
  const { CollaborationGateway } = jest.requireMock('../../collaboration/collaboration.gateway');
  class CollaborationModule {}
  NestModule({
    providers: [{ provide: CollaborationGateway, useValue: {} }],
    exports: [CollaborationGateway],
  })(CollaborationModule);
  return { CollaborationModule };
});

import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { CommentRepo } from '@docmost/db/repos/comment/comment.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { SpaceRepo } from '@docmost/db/repos/space/space.repo';
import SpaceAbilityFactory from '../../core/casl/abilities/space-ability.factory';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { WsService } from '../../ws/ws.service';
import { QueueName } from '../../integrations/queue/constants';
import { AUDIT_SERVICE } from '../../integrations/audit/audit.service';
import { CommentResolutionModule } from './comment-resolution.module';
import { CommentResolutionService } from './comment-resolution.service';
import { CommentResolutionController } from './comment-resolution.controller';

/**
 * #615 wiring: CommentResolutionService takes Kysely, two repos, WsService, the notification queue and
 * AUDIT_SERVICE from what the app provides globally, and PageAccessService + the collab gateway from the
 * modules it imports. Compile the module against @Global stand-ins for exactly the app's globals, so a
 * dependency that is NOT resolvable that way fails here rather than at boot.
 */
@Global()
@Module({
  providers: [
    { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: {} },
    { provide: PageRepo, useValue: {} },
    { provide: CommentRepo, useValue: {} },
    { provide: PagePermissionRepo, useValue: {} },
    { provide: SpaceRepo, useValue: {} },
    { provide: SpaceAbilityFactory, useValue: {} },
    { provide: WsService, useValue: {} },
    { provide: getQueueToken(QueueName.NOTIFICATION_QUEUE), useValue: {} },
    { provide: AUDIT_SERVICE, useValue: {} },
  ],
  exports: [
    KYSELY_MODULE_CONNECTION_TOKEN(),
    PageRepo,
    CommentRepo,
    PagePermissionRepo,
    SpaceRepo,
    SpaceAbilityFactory,
    WsService,
    getQueueToken(QueueName.NOTIFICATION_QUEUE),
    AUDIT_SERVICE,
  ],
})
class AppGlobalsStub {}

describe('CommentResolutionModule DI wiring (#615)', () => {
  it('resolves the controller and service from the app globals plus its imports', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppGlobalsStub, CommentResolutionModule],
    })
      .overrideGuard(JwtAuthGuard) // its own deps (EnvironmentService) are not under test here
      .useValue({ canActivate: () => true })
      .compile();
    expect(moduleRef.get(CommentResolutionService)).toBeInstanceOf(CommentResolutionService);
    expect(moduleRef.get(CommentResolutionController)).toBeInstanceOf(CommentResolutionController);
    await moduleRef.close();
  });
});
