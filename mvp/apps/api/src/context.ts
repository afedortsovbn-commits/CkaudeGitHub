import type { Lifecycle, Logger, Metrics } from '@cc/service-kit';
import type { Pool } from 'pg';
import { z } from 'zod';
import { BaseConfigSchema } from '@cc/service-kit';

export const ApiConfigSchema = BaseConfigSchema.extend({
  DATABASE_URL: z.string().url(),
  NATS_STREAM_REPLICAS: z.coerce.number().int().min(1).max(5).default(3),
  RUN_MIGRATIONS: z.enum(['true', 'false']).default('false'),
});
export type ApiConfig = z.infer<typeof ApiConfigSchema>;

export interface AppContext {
  config: ApiConfig;
  logger: Logger;
  lifecycle: Lifecycle;
  metrics: Metrics;
  pool: Pool;
}

export const APP_CONTEXT = Symbol('APP_CONTEXT');
