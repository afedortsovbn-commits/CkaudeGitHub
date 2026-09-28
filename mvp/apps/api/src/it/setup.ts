import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrincipalLoader, TokenService } from '@cc/auth';
import { newId } from '@cc/contracts';
import { createPool, migrate } from '@cc/db';
import { createMetrics, Lifecycle } from '@cc/service-kit';
import { Pool } from 'pg';
import pino from 'pino';
import { expect } from 'vitest';
import { createApp } from '../app.factory';
import { hashPassword } from '../auth/passwords';
import { seedDemo } from '../cli/demo-seed';
import { ApiConfigSchema, type AppContext } from '../context';
import { withTx } from '../lib/db';
import { createMemoryStorage } from '../lib/storage';

export const TEST_SECRETS_KEY = 'test-secrets-key-0123456789';
export const TEST_SIP_SECRET = 'test-sip-secret-0123';
export const ADMIN_URL = process.env.TEST_DATABASE_URL;
export const DEMO_PW = 'Demo12345!';

/** Тестовое приложение на отдельной временной БД с демо-данными и администратором admin@test.local. */
export async function createTestApp() {
  const dbName = `cc_it_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new Pool({ connectionString: ADMIN_URL });
  admin.on('error', () => undefined);
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(ADMIN_URL!);
  url.pathname = `/${dbName}`;
  const pool = createPool(url.toString());
  // Без обработчика 'error' Node аварийно завершает процесс на ошибке простаивающего соединения —
  // проявляется в cleanup(), когда DROP DATABASE ... WITH (FORCE) обрывает ещё закрывающиеся сокеты
  // (чаще при параллельном запуске нескольких пакетов интеграционных тестов, Ф3).
  pool.on('error', () => undefined);
  await migrate(pool);
  await withTx(pool, async (tx) => {
    const id = newId();
    await tx.query(
      `INSERT INTO app_user (id, full_name, email, password_hash) VALUES ($1, 'Админ', 'admin@test.local', $2)`,
      [id, await hashPassword(DEMO_PW)],
    );
    await tx.query(`INSERT INTO user_role VALUES ($1, 'admin')`, [id]);
    await tx.query(`INSERT INTO access_scope (id, user_id) VALUES ($1, $2)`, [newId(), id]);
    await seedDemo(tx, DEMO_PW);
  });
  const config = ApiConfigSchema.parse({
    SERVICE_NAME: 'api-test',
    DATABASE_URL: url.toString(),
    JWT_SECRET: 'x'.repeat(40),
    COOKIE_SECURE: 'false',
    SECRETS_KEY: TEST_SECRETS_KEY,
    SIP_SECRET: TEST_SIP_SECRET,
    TURN_SECRET: 'test-turn-secret',
    TURN_URLS: 'turn:turn.test:3478',
  });
  const logger = pino({ level: 'silent' });
  const lifecycle = new Lifecycle({ logger, drainDelayMs: 0, timeoutMs: 1000, exit: () => undefined });
  lifecycle.markReady();
  const ctx: AppContext = {
    config,
    logger,
    lifecycle,
    metrics: createMetrics('api-test'),
    pool,
    tokens: new TokenService(config.JWT_SECRET, 900),
    principals: new PrincipalLoader(pool, 0),
    storage: createMemoryStorage(),
    allowedOrigins: async () => true,
  };
  const app: NestFastifyApplication = await createApp(ctx);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const http = () => app.getHttpAdapter().getInstance();

  async function call(
    method: string,
    path: string,
    token?: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) {
    const res = await http().inject({
      method: method as 'GET',
      url: path,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      payload: payload as object,
    });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined, res };
  }
  async function login(email: string, password = DEMO_PW) {
    const r = await call('POST', '/api/v1/auth/login', undefined, { email, password });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.accessToken as string;
  }
  async function cleanup() {
    await app.close();
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
  return { app, http, pool, ctx, call, login, cleanup };
}
