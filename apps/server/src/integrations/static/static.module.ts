import { Inject, Module, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { join } from 'path';
import * as fs from 'node:fs';
import fastifyStatic from '@fastify/static';
import { EnvironmentService } from '../environment/environment.service';
// --- CCC standalone-mode seam (see /UPSTREAM_MODIFICATIONS.md). The SERVER is the source of truth for
// the authorization mode; it exposes a derived UI *capability* (NATIVE_AUTH_ENABLED) to the client, never
// the raw AUTHZ_MODE. The client only reflects the capability (which login to render).
import { AUTHZ_MODE, AuthzMode } from '../../authz/mode/authz-mode';

@Module({})
export class StaticModule implements OnModuleInit {
  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly environmentService: EnvironmentService,
    @Inject(AUTHZ_MODE) private readonly authzMode: AuthzMode,
  ) {}

  public async onModuleInit() {
    const httpAdapter = this.httpAdapterHost.httpAdapter;
    const app = httpAdapter.getInstance();

    const clientDistPath = join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'client/dist',
    );

    const indexFilePath = join(clientDistPath, 'index.html');

    if (fs.existsSync(clientDistPath) && fs.existsSync(indexFilePath)) {
      const indexTemplateFilePath = join(clientDistPath, 'index-template.html');
      const windowVar = '<!--window-config-->';

      const configString = {
        ENV: this.environmentService.getNodeEnv(),
        APP_URL: this.environmentService.getAppUrl(),
        CLOUD: this.environmentService.isCloud(),
        FILE_UPLOAD_SIZE_LIMIT:
          this.environmentService.getFileUploadSizeLimit(),
        FILE_IMPORT_SIZE_LIMIT:
          this.environmentService.getFileImportSizeLimit(),
        DRAWIO_URL: this.environmentService.getDrawioUrl(),
        SUBDOMAIN_HOST: this.environmentService.isCloud()
          ? this.environmentService.getSubdomainHost()
          : undefined,
        COLLAB_URL: this.environmentService.getCollabUrl(),
        BILLING_TRIAL_DAYS: this.environmentService.isCloud()
          ? this.environmentService.getBillingTrialDays()
          : undefined,
        POSTHOG_HOST: this.environmentService.getPostHogHost(),
        POSTHOG_KEY: this.environmentService.getPostHogKey(),
        // CCC: derived UI capability — true only in native (standalone) mode. Drives which sign-in the
        // SPA renders (native Docmost login vs the platform passwordless flow). The client never learns
        // the mode itself. Server-authoritative; the actual enforcement is server-side (native auth
        // routes are disabled in remote mode regardless of what the client shows).
        NATIVE_AUTH_ENABLED: this.authzMode === 'native',
      };

      const windowScriptContent = `<script>window.CONFIG=${JSON.stringify(configString)};</script>`;

      if (!fs.existsSync(indexTemplateFilePath)) {
        fs.copyFileSync(indexFilePath, indexTemplateFilePath);
      }

      const html = fs.readFileSync(indexTemplateFilePath, 'utf8');
      const transformedHtml = html.replace(windowVar, windowScriptContent);

      fs.writeFileSync(indexFilePath, transformedHtml);

      const RENDER_PATH = '*';

      await app.register(fastifyStatic, {
        root: clientDistPath,
        wildcard: false,
      });

      app.get(RENDER_PATH, (req: any, res: any) => {
        const stream = fs.createReadStream(indexFilePath);
        res
          .header('Cache-Control', 'no-cache, no-store, must-revalidate')
          .type('text/html')
          .send(stream);
      });
    }
  }
}
