import { BaseConfigSchema } from '@cc/service-kit';
import { hostname } from 'node:os';
import { z } from 'zod';

/** Общие переменные окружения коннекторов каналов. */
export const ConnectorConfigSchema = BaseConfigSchema.extend({
  DATABASE_URL: z.string().url(),
  NATS_STREAM_REPLICAS: z.coerce.number().int().min(1).max(5).default(3),
  S3_ENDPOINT: z.string().url().default('http://s3:8333'),
  S3_BUCKET: z.string().default('cc-files'),
  S3_ACCESS_KEY: z.string().default('cc'),
  S3_SECRET_KEY: z.string().default('cc-secret'),
  /** Ключ шифрования секретов каналов в БД — тот же, что у api. */
  SECRETS_KEY: z.string().min(16, 'SECRETS_KEY должен быть не короче 16 символов'),
  /** Страховочная перечитка списка каналов (основной сигнал — событие config.changed). */
  CHANNEL_RELOAD_MS: z.coerce.number().int().min(1000).default(30_000),
  /** Сколько раз пытаться доставить исходящее, прежде чем пометить его «не доставлено». */
  OUTBOUND_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(8),
  INSTANCE_ID: z.string().default(hostname()),
});
export type ConnectorConfig = z.infer<typeof ConnectorConfigSchema>;
