import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

/** Общие переменные окружения любого сервиса. */
export const BaseConfigSchema = z.object({
  SERVICE_NAME: z.string().min(1),
  APP_VERSION: z.string().default('dev'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url().optional(),
  NATS_SERVERS: z.string().default('nats://localhost:4222'),
  /** Пауза после перевода readiness в 503, пока балансировщик не перестанет слать запросы. */
  SHUTDOWN_DRAIN_DELAY_MS: z.coerce.number().int().nonnegative().default(3000),
  /** Максимальное время корректной остановки (должно быть меньше stop_grace_period контейнера). */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(25000),
  OUTBOX_RELAY_ENABLED: bool.default('true'),
});
export type BaseConfig = z.infer<typeof BaseConfigSchema>;

export function loadConfig<S extends z.ZodTypeAny = typeof BaseConfigSchema>(
  schema?: S,
  env: NodeJS.ProcessEnv = process.env,
): z.infer<S> {
  const s = (schema ?? BaseConfigSchema) as S;
  const parsed = s.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Некорректная конфигурация: ${issues}`);
  }
  return parsed.data;
}

export function natsServers(cfg: Pick<BaseConfig, 'NATS_SERVERS'>): string[] {
  return cfg.NATS_SERVERS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
