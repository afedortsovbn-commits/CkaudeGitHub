import type { Lifecycle, Logger, Metrics } from '@cc/service-kit';
import { BaseConfigSchema } from '@cc/service-kit';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { PrincipalLoader } from './auth/principal';
import type { TokenService } from './auth/tokens';

export const ApiConfigSchema = BaseConfigSchema.extend({
  DATABASE_URL: z.string().url(),
  NATS_STREAM_REPLICAS: z.coerce.number().int().min(1).max(5).default(3),
  RUN_MIGRATIONS: z.enum(['true', 'false']).default('false'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET должен быть не короче 32 символов'),
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().min(60).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).default(7),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).default(15),
  /** Secure-флаг cookie; false только для разработки по http. */
  COOKIE_SECURE: z.enum(['true', 'false']).default('true'),
});
export type ApiConfig = z.infer<typeof ApiConfigSchema>;

export interface AppContext {
  config: ApiConfig;
  logger: Logger;
  lifecycle: Lifecycle;
  metrics: Metrics;
  pool: Pool;
  tokens: TokenService;
  principals: PrincipalLoader;
}

export const APP_CONTEXT = Symbol('APP_CONTEXT');
