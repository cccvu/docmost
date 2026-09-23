import {
  Body,
  ConflictException,
  Controller,
  DefaultValuePipe,
  Get,
  HttpCode,
  HttpStatus,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SkipTransform } from '../common/decorators/skip-transform.decorator';
import { RemoteOnlyGuard } from '../authz/mode/remote-only.guard';
import { RequireServiceScope, ServiceAuthGuard } from './service-auth.guard';
import { ServiceScope } from './service-scope';
import {
  AuthzChangeFeedService,
  ChangesResult,
  StaleCursorError,
} from './authz-change-feed.service';
import { AuthzSnapshotService, SnapshotResult } from './authz-snapshot.service';
import { PageAuthzStateResult, PageAuthzStateService } from './page-authz-state.service';
import { PageAuthzStateDto } from './dto/page-authz-state.dto';

/**
 * CCC service-bridge — NOT upstream Docmost code (Group D, issue #171).
 *
 * The authz change-feed + snapshot the platform drains to project membership/page/restriction changes into
 * SpiceDB. A read-only, service-secret-guarded DATA plane carrying no policy (the platform owns projection +
 * the identity mapping). `RemoteOnlyGuard` 404s the surface unless AUTHZ_MODE=remote; the scoped
 * ServiceAuthGuard enforces `changes:read` (and `pages:authz:read` for the page-state read, #545).
 *
 * `changes` long-polls (blocks up to `wait` ms for a NOTIFY, then returns immediately); the durable outbox is
 * the source of truth, so a missed wake is only latency. A stale cursor (events GC'd past the consumer) is a
 * 409 with the current head, signalling the platform to rebaseline rather than skip.
 */
@Controller('service/authz')
@UseGuards(RemoteOnlyGuard, ServiceAuthGuard)
export class AuthzChangeController {
  constructor(
    private readonly feed: AuthzChangeFeedService,
    private readonly snapshot: AuthzSnapshotService,
    private readonly pageState: PageAuthzStateService,
  ) {}

  @SkipTransform() // bare body on the wire (spec), not the upstream envelope (#181)

  @Get('changes')
  @RequireServiceScope(ServiceScope.ChangesRead)
  async changes(
    @Query('after') after: string | undefined,
    @Query('wait', new DefaultValuePipe(0), ParseIntPipe) wait: number,
    @Query('limit', new DefaultValuePipe(500), ParseIntPipe) limit: number,
  ): Promise<ChangesResult> {
    try {
      return await this.feed.getChanges(after, wait, limit);
    } catch (e) {
      if (e instanceof StaleCursorError) {
        throw new ConflictException({ stale: true, head: e.head, message: e.message });
      }
      throw e;
    }
  }

  @SkipTransform() // bare body on the wire (spec), not the upstream envelope (#181)

  @Get('snapshot')
  @RequireServiceScope(ServiceScope.ChangesRead)
  async getSnapshot(
    @Query('cursor') cursor: string | undefined,
    @Query('limit', new DefaultValuePipe(500), ParseIntPipe) limit: number,
  ): Promise<SnapshotResult> {
    return this.snapshot.getSnapshot(cursor, limit);
  }

  // #545: the pages' CURRENT authorization structure, which the platform's page projector writes level-triggered
  // (it re-reads the pages an event names rather than trusting the event). One SQL statement per response.
  @SkipTransform() // bare body on the wire (spec), not the upstream envelope (#181)

  @Post('pages/state')
  @HttpCode(HttpStatus.OK)
  @RequireServiceScope(ServiceScope.PagesAuthzRead)
  async pagesState(@Body() dto: PageAuthzStateDto): Promise<PageAuthzStateResult> {
    return this.pageState.read(dto);
  }
}
