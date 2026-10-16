import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AiController } from './ai/ai.controller';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/guard';
import { AutomationController } from './automation/automation.controller';
import { APP_CONTEXT, type AppContext } from './context';
import { AgentStatusController } from './chat/agent-status.controller';
import { RoutingDueController } from './chat/routing-due.controller';
import { NotifyController } from './notify/notify.controller';
import { CoursesController } from './org/courses.controller';
import { ClientChatController } from './chat/client.controller';
import { ConversationsController } from './chat/conversations.controller';
import { ContactsController } from './chat/contacts.controller';
import { SupervisorController } from './chat/supervisor.controller';
import { TelephonyController } from './chat/telephony.controller';
import { HealthController } from './health.controller';
import { ImportController } from './import/import.controller';
import { IvrController } from './ivr/ivr.controller';
import { TtsController } from './ivr/tts.controller';
import { ChannelsController } from './org/channels.controller';
import { DictController } from './org/dict.controller';
import { MatrixController } from './org/matrix.controller';
import { ObjectSyncController } from './org/objects-sync.controller';
import { OrgController } from './org/org.controller';
import { ExternalAppsController } from './org/external-apps.controller';
import { ScheduleController } from './schedule/schedule.controller';
import { RolesController } from './org/roles.controller';
import { StaffPhotoController, UsersController } from './org/users.controller';
import { PingController } from './ping.controller';
import { PrivacyController } from './privacy/privacy.controller';
import { PivotController } from './reports/pivot/pivot.controller';
import { ReportsController } from './reports/reports.controller';
import { ReleaseController } from './release/release.controller';
import { SystemUpdateController } from './release/system-update.controller';
import { NotificationsController } from './tickets/notifications.controller';
import { StaffMessagesController } from './org/staff-messages.controller';
import { TestsController } from './org/tests.controller';
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
        StaffPhotoController,
        RolesController,
        ExternalAppsController,
        MatrixController,
        ClientChatController,
        ConversationsController,
        ContactsController,
        AgentStatusController,
        RoutingDueController,
        AiController,
        NotifyController,
        CoursesController,
        SupervisorController,
        TelephonyController,
        IvrController,
        TtsController,
        AutomationController,
        TicketsController,
        NotificationsController,
        StaffMessagesController,
        TestsController,
        ExtController,
        IntegrationsAdminController,
        ConfigController,
        DocsController,
        PivotController,
        ReportsController,
        ReleaseController,
        SystemUpdateController,
        PrivacyController,
        ObjectSyncController,
        ScheduleController,
        ImportController,
      ],
      providers: [
        { provide: APP_CONTEXT, useValue: ctx },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    };
  }
}
