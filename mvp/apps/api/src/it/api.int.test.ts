/**
 * Интеграционные тесты API на реальной PostgreSQL (DoD Ф1).
 * Требует TEST_DATABASE_URL (подключение с правом CREATE DATABASE); без него — пропуск.
 */
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { newId } from '@cc/contracts';
import { createPool, migrate } from '@cc/db';
import { createMetrics, Lifecycle } from '@cc/service-kit';
import { Pool } from 'pg';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.factory';
import { hashPassword } from '../auth/passwords';
import { PrincipalLoader } from '../auth/principal';
import { TokenService } from '../auth/tokens';
import { seedDemo } from '../cli/demo-seed';
import { ApiConfigSchema, type AppContext } from '../context';
import { withTx } from '../lib/db';

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DEMO_PW = 'Demo12345!';
const dbName = `cc_it_${Date.now()}`;

describe.skipIf(!ADMIN_URL)('API Ф1 (интеграция)', () => {
  let app: NestFastifyApplication;
  let pool: Pool;
  let admin: Pool;

  const http = () => app.getHttpAdapter().getInstance();
  async function call(method: string, url: string, token?: string, payload?: unknown) {
    const res = await http().inject({
      method: method as 'GET',
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload: payload as object,
    });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined, res };
  }
  async function login(email: string, password = DEMO_PW) {
    const r = await call('POST', '/api/v1/auth/login', undefined, { email, password });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.accessToken as string;
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${dbName}`;
    pool = createPool(url.toString());
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
    };
    app = await createApp(ctx);
    await app.init();
    await http().ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  it('вход, me, refresh с ротацией, выход', async () => {
    const r = await call('POST', '/api/v1/auth/login', undefined, {
      email: 'ADMIN@test.local',
      password: DEMO_PW,
    });
    expect(r.status).toBe(200);
    const cookie = r.res.cookies.find((c) => c.name === 'cc_rt')!;
    expect(cookie.httpOnly).toBe(true);
    const me = await call('GET', '/api/v1/auth/me', r.body.accessToken);
    expect(me.body.permissions).toContain('scope.all');
    const ref = await http().inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { cc_rt: cookie.value },
    });
    expect(ref.statusCode).toBe(200);
    const again = await http().inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { cc_rt: cookie.value },
    });
    expect(again.statusCode).toBe(401); // старый refresh-токен после ротации недействителен
    const newCookie = ref.cookies.find((c) => c.name === 'cc_rt')!;
    await http().inject({ method: 'POST', url: '/api/v1/auth/logout', cookies: { cc_rt: newCookie.value } });
    const afterLogout = await call('GET', '/api/v1/auth/me', JSON.parse(ref.body).accessToken);
    expect(afterLogout.status).toBe(401); // сессия отозвана — access-токен больше не принимается
  });

  it('блокировка после 5 неудачных попыток', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await call('POST', '/api/v1/auth/login', undefined, {
        email: 'operator3@demo.local',
        password: 'wrong',
      });
      expect(r.status).toBe(401);
    }
    const locked = await call('POST', '/api/v1/auth/login', undefined, {
      email: 'operator3@demo.local',
      password: DEMO_PW,
    });
    expect(locked.status).toBe(423);
  });

  it('без токена — 401; оператор без прав администратора — 403', async () => {
    expect((await call('GET', '/api/v1/dict/enterprises')).status).toBe(401);
    const op = await login('operator1@demo.local');
    expect((await call('GET', '/api/v1/users', op)).status).toBe(403);
    expect((await call('POST', '/api/v1/dict/tags', op, { name: 'x' })).status).toBe(403);
    expect((await call('GET', '/api/v1/dict/dispositions', op)).body.length).toBe(5);
  });

  it('области видимости: супервизор «Север» видит только своё, прямой доступ по id к чужому — 404', async () => {
    const adm = await login('admin@test.local');
    const all = await call('GET', '/api/v1/dict/objects', adm);
    const sup = await login('supervisor@demo.local');
    const enterprises = await call('GET', '/api/v1/dict/enterprises', sup);
    expect(enterprises.body.map((e: { code: string }) => e.code)).toEqual(['E1']);
    const e1 = enterprises.body[0].id;
    const objs = await call('GET', '/api/v1/dict/objects', sup);
    expect(objs.body.length).toBeGreaterThan(0);
    expect(objs.body.every((o: { enterpriseId: string }) => o.enterpriseId === e1)).toBe(true);
    expect(objs.body.length).toBeLessThan(all.body.length);
    const foreign = all.body.find((o: { enterpriseId: string }) => o.enterpriseId !== e1);
    expect((await call('GET', `/api/v1/dict/objects/${foreign.id}`, sup)).status).toBe(404);
    expect((await call('GET', `/api/v1/dict/objects/${foreign.id}`, adm)).status).toBe(200);
    const matrix = await call('GET', '/api/v1/responsibilities', sup);
    expect(matrix.status).toBe(200);
    expect(matrix.body.every((r: { enterpriseId: string }) => r.enterpriseId === e1)).toBe(true);
    const links = await call('GET', '/api/v1/enterprise-departments', sup);
    expect(links.body.every((r: { enterpriseId: string }) => r.enterpriseId === e1)).toBe(true);
    // изменение области вступает в силу сразу, без перезапуска
    const supId = (await call('GET', '/api/v1/auth/me', sup)).body.id;
    const put = await call('PUT', `/api/v1/users/${supId}/scopes`, adm, { rules: [] });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect((await call('GET', '/api/v1/dict/objects', sup)).body).toEqual([]);
  });

  it('сценарий администратора: предприятие, подразделение в двух предприятиях, тема со сроком и полями, матрица, подстановка', async () => {
    const adm = await login('admin@test.local');
    const ent = await call('POST', '/api/v1/dict/enterprises', adm, {
      code: 'E9',
      name: 'Предприятие «Тест»',
    });
    expect(ent.status).toBe(201);
    const e1 = (await call('GET', '/api/v1/dict/enterprises?q=Север', adm)).body[0].id;
    const dep = await call('POST', '/api/v1/dict/departments', adm, { code: 'QA', name: 'Отдел качества' });
    const links = await call('PUT', `/api/v1/departments/${dep.body.id}/enterprises`, adm, {
      enterpriseIds: [ent.body.id, e1],
    });
    expect(links.status, JSON.stringify(links.body)).toBe(200);
    expect(links.body.filter((l: { isActive: boolean }) => l.isActive)).toHaveLength(2);

    const root = await call('POST', '/api/v1/topics', adm, {
      name: 'Качество обслуживания',
      isImportant: true,
    });
    const sub = await call('POST', '/api/v1/topics', adm, {
      name: 'Чистота на АЗС',
      parentId: root.body.id,
      defaultResponseDays: 7,
    });
    expect(sub.body.level).toBe(2);
    expect(sub.body.path).toEqual([root.body.id, sub.body.id]);
    const leaf = await call('POST', '/api/v1/topics', adm, { name: 'Туалет', parentId: sub.body.id });
    expect(
      (await call('POST', '/api/v1/topics', adm, { name: '4-й уровень', parentId: leaf.body.id })).status,
    ).toBe(400);
    const field = await call('POST', `/api/v1/topics/${root.body.id}/fields`, adm, {
      key: 'station',
      label: 'Номер АЗС',
      type: 'text',
      requiredOnEscalate: true,
    });
    expect(field.status).toBe(201);
    const eff = await call('GET', `/api/v1/topics/${leaf.body.id}/effective-fields`, adm);
    expect(eff.body.map((f: { key: string }) => f.key)).toEqual(['station']);

    const users = (await call('GET', '/api/v1/users?role=responsible', adm)).body;
    const resp = users.find((u: { email: string }) => u.email === 'resp3@demo.local');
    const cur = users.find((u: { email: string }) => u.email === 'curator2@demo.local');
    const edIds = links.body.map((l: { enterpriseId: string }) => l.enterpriseId);
    const eds = (await call('GET', `/api/v1/enterprise-departments?departmentId=${dep.body.id}`, adm)).body;
    expect(eds.map((x: { enterpriseId: string }) => x.enterpriseId).sort()).toEqual(edIds.sort());
    const bulk = await call('POST', '/api/v1/responsibilities/bulk', adm, {
      enterpriseDepartmentIds: eds.map((x: { id: string }) => x.id),
      topicIds: [root.body.id],
      userIds: [resp.id],
      kind: 'responsible',
    });
    expect(bulk.body.affected).toBe(2);
    await call('POST', '/api/v1/responsibilities/bulk', adm, {
      enterpriseDepartmentIds: [eds[0].id],
      topicIds: [root.body.id],
      userIds: [cur.id],
      kind: 'curator',
    });
    const op = (await call('GET', '/api/v1/users?role=operator', adm)).body[0];
    const bad = await call('POST', '/api/v1/responsibilities/bulk', adm, {
      enterpriseDepartmentIds: [eds[0].id],
      topicIds: [root.body.id],
      userIds: [op.id],
      kind: 'responsible',
    });
    expect(bad.status).toBe(400); // оператор без роли 2-й линии не может быть ответственным

    const d = await call(
      'GET',
      `/api/v1/responsibilities/defaults?enterpriseId=${eds[0].enterpriseId}&departmentId=${dep.body.id}&topicId=${leaf.body.id}`,
      adm,
    );
    expect(d.status).toBe(200);
    expect(d.body.responsibles.map((u: { email: string }) => u.email)).toEqual(['resp3@demo.local']);
    expect(d.body.curators.map((u: { email: string }) => u.email)).toEqual(['curator2@demo.local']);
    expect(d.body.responseDays).toBe(7); // унаследован от подтемы «Чистота на АЗС»
    await call('PATCH', '/api/v1/settings', adm, { 'ticket.default_response_days': 20 });
    const d2 = await call(
      'GET',
      `/api/v1/responsibilities/defaults?enterpriseId=${eds[0].enterpriseId}&departmentId=${dep.body.id}&topicId=${root.body.id}`,
      adm,
    );
    expect(d2.body.responseDays).toBe(20); // у корня срок не задан — глобальная настройка

    const copy = await call('POST', '/api/v1/responsibilities/copy', adm, {
      fromEnterpriseId: e1,
      toEnterpriseId: ent.body.id,
    });
    expect(copy.status).toBe(200);
    expect(copy.body.missingDepartmentIds.length).toBeGreaterThan(0); // у нового предприятия есть только «Отдел качества»

    const gaps = await call('GET', `/api/v1/responsibilities/gaps?enterpriseId=${e1}`, adm);
    expect(gaps.status).toBe(200);
    expect(Array.isArray(gaps.body.topicsWithoutResponsible)).toBe(true);

    const audit = await call('GET', `/api/v1/audit?entity=topic&entityId=${sub.body.id}`, adm);
    expect(audit.body[0]).toMatchObject({ action: 'create', entity: 'topic' });
    expect(audit.body[0].actorName).toBe('Админ');
  });

  it('деактивация вместо удаления; журнал аудита неизменяем; изменения публикуют config.changed', async () => {
    const adm = await login('admin@test.local');
    const tag = await call('POST', '/api/v1/dict/tags', adm, { name: 'Временный' });
    await call('POST', `/api/v1/dict/tags/${tag.body.id}/deactivate`, adm);
    const active = (await call('GET', '/api/v1/dict/tags', adm)).body;
    expect(active.find((t: { id: string }) => t.id === tag.body.id)).toBeUndefined();
    const all = (await call('GET', '/api/v1/dict/tags?active=all', adm)).body;
    expect(all.find((t: { id: string }) => t.id === tag.body.id).isActive).toBe(false);
    await expect(pool.query(`UPDATE audit_log SET action = 'x'`)).rejects.toThrow(/неизменяем/);
    const ev = await pool.query(
      `SELECT count(*)::int AS n FROM outbox WHERE subject = 'cc.events.config.changed'`,
    );
    expect(ev.rows[0].n).toBeGreaterThan(0);
  });

  it('импорт объектов из CSV с отчётом об ошибках и обновлением по коду', async () => {
    const adm = await login('admin@test.local');
    const csv =
      'code;name;address;enterprise_code\nAZS-100;АЗС №100;ул. Новая, 1;E2\nAZS-1;АЗС №1 (обновлено);;E1\nBAD;Без предприятия;;XX\n';
    const r = await call('POST', '/api/v1/objects/import', adm, { csv });
    expect(r.body).toMatchObject({ created: 1, updated: 1 });
    expect(r.body.errors).toEqual([{ line: 4, message: 'предприятие «XX» не найдено' }]);
  });
});
