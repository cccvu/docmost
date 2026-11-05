import { Module } from '@nestjs/common';
import { PageService } from './services/page.service';
import { PageController } from './page.controller';
import { PageHistoryService } from './services/page-history.service';
import { BacklinkService } from './services/backlink.service';
import { StorageModule } from '../../integrations/storage/storage.module';
import { CollaborationModule } from '../../collaboration/collaboration.module';
import { WatcherModule } from '../watcher/watcher.module';
import { TransclusionModule } from './transclusion/transclusion.module';
import { LabelModule } from '../label/label.module';
// CCC seam #183 (#589): the trash retention is mode-selected (remote → the locked, archive-aware CCC retention).
import { trashCleanupProvider } from '../../authz/page-delete/trash-retention.provider';

@Module({
  controllers: [PageController],
  providers: [
    PageService,
    PageHistoryService,
    trashCleanupProvider, // CCC seam #183: was `TrashCleanupService`
    BacklinkService,
  ],
  exports: [PageService, PageHistoryService],
  imports: [
    StorageModule,
    CollaborationModule,
    WatcherModule,
    TransclusionModule,
    LabelModule,
  ],
})
export class PageModule {}
