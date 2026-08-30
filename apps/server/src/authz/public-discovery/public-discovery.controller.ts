import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Workspace } from '@docmost/db/types/entity.types';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { PublicDiscoveryService } from './public-discovery.service';
import { ListPublicPagesDto } from './dto';

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * The anonymous public-content discovery surface that backs the signed-out front page. `@Public()`
 * opts the single read-only handler out of JwtAuthGuard; `@AuthWorkspace()` (set by DomainMiddleware,
 * which runs on every route) hard-scopes the query to one tenant independent of any session — a
 * missing workspace throws BadRequest, so there is no cross-tenant fallthrough. Mounted via
 * AuthzModule (no upstream file edit). It changes the set of anonymously-viewable pages by zero:
 * every listed page is already served anonymously by the existing share read path.
 */
@UseGuards(JwtAuthGuard)
@Controller('public/pages')
export class PublicDiscoveryController {
  constructor(private readonly discovery: PublicDiscoveryService) {}

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('list')
  async list(
    @Body() dto: ListPublicPagesDto,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.discovery.listPublicPages(dto, workspace.id);
  }
}
