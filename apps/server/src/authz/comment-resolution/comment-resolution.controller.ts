import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { CommentResolutionService } from './comment-resolution.service';
import { ResolveCommentDto } from './dto';

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * `POST /api/comments/resolve` (#615) — see CommentResolutionService for the checks and their order.
 *
 * A NORMAL relayed route under `JwtAuthGuard`, like the conditional page write: it runs as the caller's own
 * (shadow) user and re-runs Docmost's `validateCanComment`, so the fork's independent re-check still applies.
 * It shares the `comments` prefix with upstream's CommentController on purpose (the SPA's licence-gated resolve
 * button targets this path). Should an upstream bump ever ship its own `comments/resolve`, the duplicate route fails the boot
 * loudly rather than one silently shadowing the other.
 *
 * Keeps the upstream `{ data, success }` envelope (no `@SkipTransform`): the SPA's api client and the platform
 * relay both unwrap it.
 */
@UseGuards(JwtAuthGuard)
@Controller('comments')
export class CommentResolutionController {
  constructor(private readonly resolution: CommentResolutionService) {}

  @HttpCode(HttpStatus.OK)
  @Post('resolve')
  resolve(
    @Body() dto: ResolveCommentDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.resolution.setResolved(dto, user, workspace);
  }
}
