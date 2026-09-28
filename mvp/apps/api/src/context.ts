import type { Lifecycle, Logger, Metrics } from '@cc/service-kit';
import { BaseConfigSchema } from '@cc/service-kit';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { PrincipalLoader } from '@cc/auth';
import type { TokenService } from '@cc/auth';
import type { JetStreamClient } from 'nats';
import type { Storage } from './lib/storage';

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
  S3_ENDPOINT: z.string().url().default('http://s3:8333'),
  S3_BUCKET: z.string().default('cc-files'),
  S3_ACCESS_KEY: z.string().default('cc'),
  S3_SECRET_KEY: z.string().default('cc-secret'),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(100).default(10),
  /** Ключ шифрования секретов интеграций в БД (токены ботов, пароли почты); тот же — у коннекторов. */
  SECRETS_KEY: z.string().min(16, 'SECRETS_KEY должен быть не короче 16 символов').optional(),
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
  /** Публикация во входящий поток (клиентский API как коннектор веб-чата). В тестах может отсутствовать. */
  js?: JetStreamClient;
  storage: Storage;
  /** Разрешён ли домен сайта для клиентского API (объединение allowed_origins активных каналов). */
  allowedOrigins?: (origin: string) => Promise<boolean>;
}

export const APP_CONTEXT = Symbol('APP_CONTEXT');
