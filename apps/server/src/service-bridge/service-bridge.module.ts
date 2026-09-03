import { Module } from '@nestjs/common';
import { ServiceBridgeController } from './service-bridge.controller';
import { ServiceBridgeService } from './service-bridge.service';
import { ServiceAuthGuard } from './service-auth.guard';

/**
 * CCC service-bridge — NOT upstream Docmost code.
 *
 * Mounts the east-west `/api/service/*` endpoints (session brokerage + provisioning). Its deps —
 * SessionService (@Global SessionModule), UserRepo + Kysely (@Global DatabaseModule), EnvironmentService
 * (@Global) and Reflector — are all globally available, so this module is registered via AuthzModule
 * (already in the graph) with NO app.module edit. In native mode the endpoints exist but are inert (the
 * ServiceAuthGuard fails closed without a service secret).
 */
@Module({
  controllers: [ServiceBridgeController],
  providers: [ServiceBridgeService, ServiceAuthGuard],
})
export class ServiceBridgeModule {}
