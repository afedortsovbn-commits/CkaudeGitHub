import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/guard';
import { AutomationController } from './automation/automation.controller';
import { APP_CONTEXT, type AppContext } from './context';
import { AgentStatusController } from './chat/agent-status.controller';
import { ClientChatController } from './chat/client.controller';
import { ConversationsController } from './chat/conversations.controller';
import { ContactsController } from './chat/contacts.controller';
import { SupervisorController } from './chat/supervisor.controller';
import { TelephonyController } from './chat/telephony.controller';
import { HealthController } from './health.controller';
import { IvrController } from './ivr/ivr.controller';
import { ChannelsController } from './org/channels.controller';
import { DictController } from './org/dict.controller';
import { MatrixController } from './org/matrix.controller';
import { OrgController } from './org/org.controller';
import { UsersController } from './org/users.controller';
import { PingController } from './ping.controller';
import { PrivacyController } from './privacy/privacy.controller';
import { ReportsController } from './reports/reports.controller';
import { ReleaseController } from './release/release.controller';
import { NotificationsController } from './tickets/notifications.controller';
import { TicketsController } from './tickets/tickets.controller';
import { ConfigController } from './config/config.controller';
import { DocsController } from './ext/docs.controller';
import { ExtController } from './ext/ext.controller';
import { IntegrationsAdminController } from './ext/integrations-admin.controller';

@Module({})
export class AppModule {
  static register(ctx: AppContext): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        HealthController,
        PingController,
        AuthController,
        DictController,
        ChannelsController,
        OrgController,
        UsersController,
        MatrixController,
        ClientChatController,
        ConversationsController,
        ContactsController,
        AgentStatusController,
        SupervisorController,
        TelephonyController,
        IvrController,
        AutomationController,
        TicketsController,
        NotificationsController,
        ExtController,
        IntegrationsAdminController,
        ConfigController,
        DocsController,
        ReportsController,
        ReleaseController,
        PrivacyController,
      ],
      providers: [
        { provide: APP_CONTEXT, useValue: ctx },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    };
  }
}
