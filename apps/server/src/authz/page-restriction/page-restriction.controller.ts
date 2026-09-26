import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { User } from '@docmost/db/types/entity.types';
import { PageRestrictionService } from './page-restriction.service';
import {
  AddPagePermissionDto,
  RemovePagePermissionDto,
  RemoveRestrictionDto,
  RestrictionPreviewDto,
  RestrictPageDto,
  UpdatePagePermissionDto,
} from './dto';

/**
 * CCC authorization integration — NOT upstream Docmost code.
 *
 * The page-restriction write surface the EE client already calls (`/pages/restrict`, … ), which the
 * OSS server never vendored. Mounted via our AuthzModule (no upstream file edit). All authorization
 * + writes live in PageRestrictionService; SpiceDB projection is handled out-of-process by the
 * platform's DB-trigger outbox.
 *
 * #616: every write also answers the page ACL's new `version` and the write's `effect` (inside the upstream
 * `{ data, success }` envelope), and takes an optional `expectedVersion` compared atomically (412 when stale).
 * `restriction-preview` runs one of the five writes and rolls it back; it narrows nothing, so it is NOT a narrowing
 * route (`live-access/narrowing-routes.ts`) and answers without a settle.
 */
@UseGuards(JwtAuthGuard)
@Controller('pages')
export class PageRestrictionController {
  constructor(private readonly restriction: PageRestrictionService) {}

  @HttpCode(HttpStatus.OK)
  @Post('restrict')
  async restrict(@Body() dto: RestrictPageDto, @AuthUser() user: User) {
    return { restricted: true, ...(await this.restriction.restrict(dto.pageId, user, expected(dto))) };
  }

  @HttpCode(HttpStatus.OK)
  @Post('remove-restriction')
  async removeRestriction(@Body() dto: RemoveRestrictionDto, @AuthUser() user: User) {
    return {
      restricted: false,
      ...(await this.restriction.unrestrict(dto.pageId, user, {
        requireActorCoverage: dto.requireActorCoverage === true,
        ...expected(dto),
      })),
    };
  }

  @HttpCode(HttpStatus.OK)
  @Post('add-permission')
  async addPermission(@Body() dto: AddPagePermissionDto, @AuthUser() user: User) {
    return { success: true, ...(await this.restriction.addPermission(dto, user)) };
  }

  @HttpCode(HttpStatus.OK)
  @Post('remove-permission')
  async removePermission(@Body() dto: RemovePagePermissionDto, @AuthUser() user: User) {
    return { success: true, ...(await this.restriction.removePermission(dto, user)) };
  }

  @HttpCode(HttpStatus.OK)
  @Post('update-permission')
  async updatePermission(@Body() dto: UpdatePagePermissionDto, @AuthUser() user: User) {
    return { success: true, ...(await this.restriction.updatePermission(dto, user)) };
  }

  /** #616: what one of the five writes above would do — run for real, then rolled back. Not a narrowing route. */
  @HttpCode(HttpStatus.OK)
  @Post('restriction-preview')
  async restrictionPreview(@Body() dto: RestrictionPreviewDto, @AuthUser() user: User) {
    return this.restriction.preview(dto, user);
  }
}

/** The optional compare, passed on only when the caller sent one. */
const expected = (dto: { expectedVersion?: string }): { expectedVersion?: string } =>
  dto.expectedVersion === undefined ? {} : { expectedVersion: dto.expectedVersion };
