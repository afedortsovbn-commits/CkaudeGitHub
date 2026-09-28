import { type DynamicModule, Module } from '@nestjs/common';
import { APP_CONTEXT, type AppContext } from './context';
import { HealthController } from './health.controller';
import { PingController } from './ping.controller';

@Module({})
export class AppModule {
  static register(ctx: AppContext): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, PingController],
      providers: [{ provide: APP_CONTEXT, useValue: ctx }],
    };
  }
}
