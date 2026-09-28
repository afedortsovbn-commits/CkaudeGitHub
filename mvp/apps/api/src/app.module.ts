import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/guard';
import { APP_CONTEXT, type AppContext } from './context';
import { HealthController } from './health.controller';
import { DictController } from './org/dict.controller';
import { MatrixController } from './org/matrix.controller';
import { OrgController } from './org/org.controller';
import { UsersController } from './org/users.controller';
import { PingController } from './ping.controller';

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
        OrgController,
        UsersController,
        MatrixController,
      ],
      providers: [
        { provide: APP_CONTEXT, useValue: ctx },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    };
  }
}
