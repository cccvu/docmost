import { Body, Controller, Get, HttpCode, HttpStatus, Patch, UseGuards } from '@nestjs/common';
import { SkipTransform } from '../common/decorators/skip-transform.decorator';
import { RemoteOnlyGuard } from '../authz/mode/remote-only.guard';
import { RequireServiceScope, ServiceAuthGuard } from './service-auth.guard';
import { ServiceScope } from './service-scope';
import { ServiceWorkspaceService, WorkspaceSettingsView } from './service-workspace.service';
import { UpdateWorkspaceSettingsDto } from './dto/workspace-settings.dto';
import { WorkspaceResolver } from './workspace-resolver';

/**
 * CCC service-bridge — NOT upstream Docmost code.
 *
 * The canonical-workspace + workspace-settings surface the platform calls (it authorizes
 * `workspace#administer` first for the settings write). `RemoteOnlyGuard` 404s the whole surface unless
 * AUTHZ_MODE=remote; the scoped ServiceAuthGuard then enforces least privilege.
 */
@Controller('service/workspace')
@UseGuards(RemoteOnlyGuard, ServiceAuthGuard)
export class ServiceWorkspaceController {
  constructor(
    private readonly workspaces: WorkspaceResolver,
    private readonly service: ServiceWorkspaceService,
  ) {}

  @SkipTransform() // bare body on the wire (spec), not the upstream envelope (#181)

  @Get('default')
  @RequireServiceScope(ServiceScope.WorkspaceRead)
  async getDefault(): Promise<{ workspaceId: string }> {
    return { workspaceId: await this.workspaces.resolveDefaultWorkspaceId() };
  }

  @SkipTransform() // bare body on the wire (spec), not the upstream envelope (#181)

  @Get('settings')
  @RequireServiceScope(ServiceScope.WorkspaceRead)
  async getSettings(): Promise<WorkspaceSettingsView> {
    return this.service.getSettings();
  }

  @SkipTransform() // bare body on the wire (spec), not the upstream envelope (#181)

  @Patch('settings')
  @HttpCode(HttpStatus.OK)
  @RequireServiceScope(ServiceScope.WorkspaceSettingsWrite)
  async updateSettings(@Body() dto: UpdateWorkspaceSettingsDto): Promise<WorkspaceSettingsView> {
    return this.service.updateSettings(dto);
  }
}
