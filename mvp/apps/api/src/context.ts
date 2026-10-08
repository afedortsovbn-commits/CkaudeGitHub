import type { Lifecycle, Logger, Metrics } from '@cc/service-kit';
import { BaseConfigSchema } from '@cc/service-kit';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { PrincipalLoader } from '@cc/auth';
import type { TokenService } from '@cc/auth';
import type { JetStreamClient, NatsConnection } from 'nats';
import type { Storage } from './lib/storage';
import type { ApiKeyStore } from './ext/api-key';

export const ApiConfigSchema = BaseConfigSchema.extend({
  DATABASE_URL: z.string().url(),
  NATS_STREAM_REPLICAS: z.coerce.number().int().min(1).max(5).default(3),
  RUN_MIGRATIONS: z.enum(['true', 'false']).default('false'),
  /**
   * Роль экземпляра: full — всё; reports — только отвечает на запросы (Traefik присылает ему отчёты и выгрузки),
   * без фоновых задач: доставки событий в чаты, интеграций IVR и ботов, заданий по расписанию.
   */
  API_ROLE: z.enum(['full', 'reports']).default('full'),
  /** Подключений к базе у экземпляра (у экземпляра отчётов — меньше: отчёты не забирают подключения у чатов). */
  PG_POOL_MAX: z.coerce.number().int().min(2).max(50).default(10),
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
  // ---- Телефония (Ф5) ----
  /** Общий с Kamailio секрет короткоживущих SIP-паролей (auth_ephemeral); не задан — софтфон выключен. */
  SIP_SECRET: z.string().min(8).optional(),
  SIP_DOMAIN: z.string().default('cc.local'),
  /** Адрес WSS Kamailio для браузера; по умолчанию wss://<адрес КЦ>:8443. */
  SIP_WSS_URL: z.string().optional(),
  SIP_WSS_PORT: z.coerce.number().int().default(8443),
  SIP_CREDENTIALS_TTL_H: z.coerce.number().int().min(1).max(72).default(12),
  /** TURN (coturn, TURN REST API): адреса через запятую (turn:host:3478) и общий секрет. */
  TURN_URLS: z.string().default(''),
  TURN_SECRET: z.string().optional(),
  /** Демо-страница «Позвонить в КЦ» (WebRTC-абонент без SIP-транка) — только для демо-стенда. */
  DEMO_CALLER_ENABLED: z.enum(['true', 'false']).default('false'),
  DEMO_CALLER_DID: z.string().default('1000'),
  /**
   * Вход в один клик под демо-учётками (страница /demo-login?as=<email>) — только демо-стенд: api выполняет обычный
   * вход (блокировка, 2FA, аудит) с известным паролем — DEMO_PASSWORD для *@demo.local, DEMO_ADMIN_PASSWORD для
   * DEMO_ADMIN_EMAIL. На рабочем сервере выключено.
   */
  DEMO_QUICK_LOGIN: z.enum(['true', 'false']).default('false'),
  DEMO_PASSWORD: z.string().optional(),
  DEMO_ADMIN_PASSWORD: z.string().optional(),
  DEMO_ADMIN_EMAIL: z.string().default('admin@cc.local'),
  // ---- Публичный API и webhooks (Ф9) ----
  /** Адрес системы для ссылок (документация API, ход внешнего бота). */
  PUBLIC_BASE_URL: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().url().default('https://localhost'),
  ),
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
  /** Команды call-control (NATS request/reply). В тестах может отсутствовать. */
  nc?: NatsConnection;
  storage: Storage;
  /** Разрешён ли домен сайта для клиентского API (объединение allowed_origins активных каналов). */
  allowedOrigins?: (origin: string) => Promise<boolean>;
  /** Ключи публичного API (Ф9): создаётся при первом обращении. */
  apiKeys?: ApiKeyStore;
}

export const APP_CONTEXT = Symbol('APP_CONTEXT');
