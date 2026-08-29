import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { User } from '@docmost/db/types/entity.types';
import { PageRestrictionService } from './page-restriction.service';
import {
  AddPagePermissionDto,
  RemovePagePermissionDto,
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
 */
@UseGuards(JwtAuthGuard)
@Controller('pages')
export class PageRestrictionController {
  constructor(private readonly restriction: PageRestrictionService) {}

  @HttpCode(HttpStatus.OK)
  @Post('restrict')
  async restrict(@Body() dto: RestrictPageDto, @AuthUser() user: User) {
    await this.restriction.restrict(dto.pageId, user);
    return { restricted: true };
  }

  @HttpCode(HttpStatus.OK)
  @Post('remove-restriction')
  async removeRestriction(@Body() dto: RestrictPageDto, @AuthUser() user: User) {
    await this.restriction.unrestrict(dto.pageId, user);
    return { restricted: false };
  }

  @HttpCode(HttpStatus.OK)
  @Post('add-permission')
  async addPermission(@Body() dto: AddPagePermissionDto, @AuthUser() user: User) {
    await this.restriction.addPermission(dto, user);
    return { success: true };
  }

  @HttpCode(HttpStatus.OK)
  @Post('remove-permission')
  async removePermission(@Body() dto: RemovePagePermissionDto, @AuthUser() user: User) {
    await this.restriction.removePermission(dto, user);
    return { success: true };
  }

  @HttpCode(HttpStatus.OK)
  @Post('update-permission')
  async updatePermission(@Body() dto: UpdatePagePermissionDto, @AuthUser() user: User) {
    await this.restriction.updatePermission(dto, user);
    return { success: true };
  }
}
