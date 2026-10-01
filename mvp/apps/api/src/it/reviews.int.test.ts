/**
 * Интеграционные тесты Ф13: отзывы с карт через Rocket Data (M-CH-10) — приём, объект → предприятие, дубли,
 * изменённый отзыв, ответ в Rocket Data и статус, отчёт по отзывам; синхронизация справочника объектов (M-ORG-06).
 */
import { type InboundMessage, newId, type ReviewMeta, SECRET_MASK } from '@cc/contracts';
import {
  afterInbound,
  applyDeliveryStatus,
  ingestInbound,
  runScheduledObjectSync,
  syncObjects,
} from '@cc/domain';
import { openSecret } from '@cc/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedReviewsDemo } from '../cli/reviews-demo-seed';
import { withTx } from '../lib/db';
import { ADMIN_URL, createTestApp, DEMO_PW, TEST_SECRETS_KEY } from './setup';

describe.skipIf(!ADMIN_URL)('Отзывы с карт и синхронизация объектов Ф13 (интеграция)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let admin: string;
  let op: string;
  let channelId: string;
  const one = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) =>
    (await t.pool.query(sql, p)).rows[0] as T;

  beforeAll(async () => {
    t = await createTestApp();
    await withTx(t.pool, (tx) =>
      seedReviewsDemo(tx, { mockUrl: 'http://mock-selfservice:3000', secretsKey: TEST_SECRETS_KEY }),
    );
    admin = await t.login('admin@test.local', DEMO_PW);
    op = await t.login('operator1@demo.local');
    channelId = (await one<{ id: string }>(`SELECT id FROM channel WHERE kind = 'review'`)).id;
    // Приветствие для «всех текстовых каналов» — на отзыв публично не отвечает (правило не выбрало канал явно).
    await t.pool.query(
      `INSERT INTO auto_reply_rule (id, name, kind, text) VALUES ($1, 'Приветствие всем', 'greeting', 'Здравствуйте!')`,
      [newId()],
    );
  }, 60_000);
  afterAll(async () => t?.cleanup());

  const review = (over: Partial<ReviewMeta> & { text?: string; ext?: string } = {}): InboundMessage => {
    const { text = 'Долго ждал на кассе', ext, ...meta } = over;
    const r: ReviewMeta = {
      id: 'r-1',
      platform: 'yandex',
      rating: 2,
      author: 'Иван',
      url: 'https://yandex.by/maps/org/1/reviews',
      publishedAt: '2026-09-29T10:00:00.000Z',
      locationId: 'rd-azs-1',
      locationCode: null,
      answered: false,
      urgent: (meta.rating ?? 2) <= 2,
      skipAnswered: true,
      ...meta,
    };
    return {
      id: newId(),
      channelId,
      channelKind: 'review',
      externalId: ext ?? `rd:${channelId}:${r.id}:${r.rating}:${text.length}`,
      identity: { kind: 'other', value: `review:${channelId}:${r.id}` },
      contact: { displayName: `${r.author ?? 'Автор отзыва'} (Яндекс Карты)` },
      body: text,
      attachments: [],
      receivedAt: Date.now(),
      meta: { review: r },
    };
  };
  const ingest = (m: InboundMessage) =>
    withTx(t.pool, async (tx) => {
      const r = await ingestInbound(tx, m);
      if (!r.duplicate)
        await afterInbound(tx, { conversationId: r.conversationId, created: r.created, body: m.body });
      return r;
    });

  it('канал «Отзыв»: настройки проверяются, токен Rocket Data шифруется и маскируется', async () => {
    const bad = await t.call('POST', '/api/v1/dict/channels', admin, {
      kind: 'review',
      name: 'Без адреса',
      config: { api_token: 'x' },
    });
    expect(bad.status).toBe(400);
    // Канал «Отзыв» создаётся через справочник каналов (форма администратора).
    const created = await t.call('POST', '/api/v1/dict/channels', admin, {
      kind: 'review',
      name: 'Rocket Data (второе подключение)',
      config: { api_url: 'http://rd.local', api_token: 'second-token' },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.config).toMatchObject({ api_token: SECRET_MASK, poll_interval_s: 300 });
    await t.call('POST', `/api/v1/dict/channels/${created.body.id}/deactivate`, admin);
    const ch = await t.call('GET', `/api/v1/dict/channels/${channelId}`, admin);
    expect(ch.body.config).toMatchObject({ api_token: SECRET_MASK, poll_interval_s: 10, low_rating_max: 2 });
    const raw = await one<{ config: { api_token: string } }>(`SELECT config FROM channel WHERE id = $1`, [
      channelId,
    ]);
    expect(openSecret(raw.config.api_token, TEST_SECRETS_KEY)).toBe('demo-rocketdata-token');
  });

  let convId = '';
  it('отзыв → обращение предприятия объекта: объект по точке Rocket Data, срочность, сведения для карточки', async () => {
    const r = await ingest(review());
    expect(r.created).toBe(true);
    convId = r.conversationId;
    const c = await one<Record<string, unknown>>(
      `SELECT c.status, c.is_urgent, c.channel_meta, o.code AS object_code, e.code AS enterprise_code, q.name AS queue
         FROM conversation c JOIN service_object o ON o.id = c.object_id JOIN enterprise e ON e.id = c.enterprise_id
         JOIN queue q ON q.id = c.queue_id WHERE c.id = $1`,
      [convId],
    );
    expect(c).toMatchObject({
      status: 'queued',
      is_urgent: true,
      object_code: 'AZS-1',
      enterprise_code: 'E1',
      queue: 'Отзывы',
      channel_meta: { review: { id: 'r-1', platform: 'yandex', rating: 2, author: 'Иван' } },
    });
    // Приветствие «для всех каналов» не ушло публичным ответом на отзыв.
    const out = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM message WHERE conversation_id = $1 AND direction = 'out'`,
      [convId],
    );
    expect(out.n).toBe(0);
    // Карточка оператора: отзыв и объект; в списке — оценка.
    expect((await t.call('POST', `/api/v1/conversations/${convId}/take`, op)).status).toBe(200);
    const card = await t.call('GET', `/api/v1/conversations/${convId}`, op);
    expect(card.body).toMatchObject({
      channelKind: 'review',
      reviewRating: 2,
      objectName: 'АЗС №1',
      review: { id: 'r-1', platform: 'yandex', url: 'https://yandex.by/maps/org/1/reviews' },
    });
  });

  it('повторная загрузка того же отзыва — не дубль; изменённый автором — новое сообщение того же обращения', async () => {
    const again = await ingest(review());
    expect(again).toMatchObject({ duplicate: true, conversationId: convId });
    const edited = await ingest(review({ rating: 4, text: 'Исправились, спасибо' }));
    expect(edited).toMatchObject({ created: false, duplicate: false, conversationId: convId });
    const msgs = await t.call('GET', `/api/v1/conversations/${convId}/messages`, op);
    const ins = msgs.body.filter((m: { direction: string }) => m.direction === 'in');
    expect(ins.map((m: { body: string }) => m.body)).toEqual(['Долго ждал на кассе', 'Исправились, спасибо']);
    expect(ins[1].meta).toEqual({ review: { rating: 4, edited: true } });
    const c = await one<{ rating: string }>(
      `SELECT channel_meta #>> '{review,rating}' AS rating FROM conversation WHERE id = $1`,
      [convId],
    );
    expect(c.rating).toBe('4');
  });

  it('ответ оператора уходит в Rocket Data (id отзыва), статус доставки; файлы и пустой ответ — «не доставлено»', async () => {
    const sent = await t.call('POST', `/api/v1/conversations/${convId}/messages`, op, {
      body: 'Спасибо за отзыв! Разобрались с кассой.',
    });
    expect(sent.status).toBe(201);
    expect(sent.body.deliveryStatus).toBe('pending');
    const cmd = await one<{ subject: string; payload: Record<string, unknown> }>(
      `SELECT subject, payload FROM outbox WHERE id = $1`,
      [sent.body.id],
    );
    expect(cmd.subject).toBe('cc.outbound.review');
    expect(cmd.payload).toMatchObject({ channelKind: 'review', channelId, to: 'r-1' });
    await withTx(t.pool, (tx) =>
      applyDeliveryStatus(tx, {
        messageId: sent.body.id,
        channelId,
        status: 'sent',
        externalId: `rd-answer:${channelId}:a-1`,
        error: null,
        at: Date.now(),
      }),
    );
    const m = await one<{ delivery_status: string }>(`SELECT delivery_status FROM message WHERE id = $1`, [
      sent.body.id,
    ]);
    expect(m.delivery_status).toBe('sent');

    const up = await t.http().inject({
      method: 'POST',
      url: '/api/v1/attachments',
      headers: { authorization: `Bearer ${op}`, 'content-type': 'text/plain', 'x-filename': 'a.txt' },
      payload: 'файл',
    });
    expect(up.statusCode, up.body).toBe(201);
    const withFile = await t.call('POST', `/api/v1/conversations/${convId}/messages`, op, {
      body: 'см. файл',
      attachmentIds: [JSON.parse(up.body).id],
    });
    expect(withFile.body.deliveryStatus).toBe('failed');
  });

  it('точка без объекта — обращение без предприятия и служебная подсказка; отвеченный на площадке — пропускается', async () => {
    const r = await ingest(review({ id: 'r-2', locationId: 'rd-unknown', locationCode: 'X-9', rating: 5 }));
    const c = await one<{ enterprise_id: string | null; object_id: string | null; is_urgent: boolean }>(
      `SELECT enterprise_id, object_id, is_urgent FROM conversation WHERE id = $1`,
      [r.conversationId],
    );
    expect(c).toEqual({ enterprise_id: null, object_id: null, is_urgent: false });
    const sys = await one<{ body: string }>(
      `SELECT body FROM message WHERE conversation_id = $1 AND direction = 'system'`,
      [r.conversationId],
    );
    expect(sys.body).toContain('код «X-9»');
    // По коду объекта (без идентификатора Rocket Data).
    const byCode = await ingest(review({ id: 'r-3', locationId: null, locationCode: 'AZS-3', rating: 3 }));
    const e = await one<{ code: string }>(
      `SELECT e.code FROM conversation c JOIN enterprise e ON e.id = c.enterprise_id WHERE c.id = $1`,
      [byCode.conversationId],
    );
    expect(e.code).toBe('E2');
    const skipped = await ingest(review({ id: 'r-4', answered: true }));
    expect(skipped).toMatchObject({ skipped: true, duplicate: true });
    expect(
      (
        await one<{ n: number }>(
          `SELECT count(*)::int AS n FROM conversation WHERE channel_meta #>> '{review,id}' = 'r-4'`,
        )
      ).n,
    ).toBe(0);
    // Известный отзыв после ответа из системы (answered) обрабатывается как обычно — дубль отсекается ключом.
    expect(await ingest(review({ answered: true }))).toMatchObject({
      duplicate: true,
      conversationId: convId,
    });
  });

  it('отчёт по отзывам: по оценкам, площадкам, предприятиям; доля отвеченных; область видимости', async () => {
    const q = 'from=2026-09-01&to=2026-09-30';
    const byRating = await t.call('GET', `/api/v1/reports/reviews?${q}&groupBy=rating`, admin);
    expect(byRating.status, JSON.stringify(byRating.body)).toBe(200);
    expect(byRating.body.totals).toMatchObject({ n: 3, answered: 1, answered_pct: 33.3 });
    expect(byRating.body.rows.map((r: { key: string; n: number }) => [r.key, r.n])).toEqual([
      ['5', 1],
      ['4', 1],
      ['3', 1],
    ]);
    const byEnt = await t.call('GET', `/api/v1/reports/reviews?${q}&groupBy=enterprise`, admin);
    const labels = Object.fromEntries(
      byEnt.body.rows.map((r: { label: string; n: number; answered: number }) => [
        r.label,
        [r.n, r.answered],
      ]),
    );
    expect(labels).toMatchObject({ 'Предприятие «Север»': [1, 1], 'Не указано': [1, 0] });
    const byPlatform = await t.call('GET', `/api/v1/reports/reviews?${q}&groupBy=platform`, admin);
    expect(byPlatform.body.rows[0]).toMatchObject({ label: 'Яндекс Карты', n: 3 });
    const csv = await t.http().inject({
      method: 'GET',
      url: `/api/v1/reports/reviews?${q}&groupBy=object&format=csv`,
      headers: { authorization: `Bearer ${admin}` },
    });
    expect(csv.body).toContain('Доля отвеченных, %');
    // Супервизор «Севера» видит только отзывы своего предприятия.
    const sup = await t.login('supervisor@demo.local');
    const own = await t.call('GET', `/api/v1/reports/reviews?${q}&groupBy=enterprise`, sup);
    expect(own.body.totals).toMatchObject({ n: 1, answered: 1 });
  });

  // ------------------------------------------------------------ синхронизация объектов
  const item = (code: string, name: string, ent: string, extra: Record<string, unknown> = {}) => ({
    code,
    name,
    address: `адрес ${code}`,
    enterprise_code: ent,
    external_ids: { rocketdata: `rd-${code.toLowerCase()}` },
    ...extra,
  });
  const baseFeed = () => [
    ...['E1', 'E1', 'E2', 'E2', 'E3', 'E3'].map((e, i) => item(`AZS-${i + 1}`, `АЗС №${i + 1}`, e)),
    item('EV-1', 'ЭЗС-1', 'E1'),
  ];
  const run = (feed: unknown, dryRun = false) =>
    syncObjects(t.pool, {
      trigger: 'manual',
      dryRun,
      settings: {
        enabled: true,
        url: 'http://x',
        format: 'json',
        token: null,
        time: '03:00',
        maxDeactivateShare: 0.3,
      },
      feed: async () => JSON.stringify(feed),
    });
  const obj = (code: string) =>
    one<{
      name: string;
      source: string;
      is_active: boolean;
      enterprise: string;
      ext: Record<string, string>;
    }>(
      `SELECT o.name, o.source, o.is_active, e.code AS enterprise, o.external_ids AS ext
         FROM service_object o JOIN enterprise e ON e.id = o.enterprise_id WHERE o.code = $1`,
      [code],
    );

  it('проверка без изменений: итог и журнал как у запуска, справочник не меняется', async () => {
    const r = await run([...baseFeed(), item('AZS-7', 'АЗС №7', 'E2')], true);
    expect(r).toMatchObject({ status: 'ok', dryRun: true, added: 1, total: 8 });
    expect(await one(`SELECT 1 AS x FROM service_object WHERE code = 'AZS-7'`)).toBeUndefined();
    expect((await obj('AZS-1')).source).toBe('manual');
  });

  it('синхронизация: добавляет, обновляет и берёт под управление, деактивирует исчезнувшие, журнал изменений', async () => {
    const feed = [...baseFeed(), item('AZS-7', 'АЗС №7', 'E2')];
    feed[1] = item('AZS-2', 'АЗС №2 (Центр)', 'E2');
    const r1 = await run(feed);
    expect(r1).toMatchObject({ status: 'ok', added: 1, deactivated: 0 });
    expect(r1.updated).toBe(7); // все прежние объекты перешли под синхронизацию (source), AZS-2 ещё и изменён
    expect(await obj('AZS-2')).toMatchObject({ name: 'АЗС №2 (Центр)', enterprise: 'E2', source: 'sync' });
    expect(await obj('AZS-7')).toMatchObject({
      source: 'sync',
      is_active: true,
      ext: { rocketdata: 'rd-azs-7' },
    });
    const change = r1.changes.find((c) => c.code === 'AZS-2')!;
    expect(change.fields).toMatchObject({ name: { from: 'АЗС №2', to: 'АЗС №2 (Центр)' } });

    // Повтор той же выгрузки — без изменений.
    expect(await run(feed)).toMatchObject({ added: 0, updated: 0, deactivated: 0 });

    // AZS-6 исчез, EV-1 закрыт, у строки AZS-5 неизвестное предприятие (объект не трогается), дубль кода.
    const next = feed.filter((f) => f.code !== 'AZS-6');
    next[next.findIndex((f) => f.code === 'EV-1')] = item('EV-1', 'ЭЗС-1', 'E1', { is_active: false });
    next[next.findIndex((f) => f.code === 'AZS-5')] = item('AZS-5', 'АЗС №5', 'NOPE');
    next.push(item('AZS-7', 'дубль', 'E2'));
    const r2 = await run(next);
    expect(r2).toMatchObject({ status: 'ok', deactivated: 2, skipped: 2 });
    expect(r2.problems.map((p) => p.code).sort()).toEqual(['AZS-5', 'AZS-7']);
    expect((await obj('AZS-6')).is_active).toBe(false);
    expect((await obj('EV-1')).is_active).toBe(false);
    expect((await obj('AZS-5')).is_active).toBe(true);
    // Вернулся в выгрузку — снова активен.
    const r3 = await run(feed);
    expect(r3.reactivated).toBe(2);

    const runs = await t.call('GET', '/api/v1/objects/sync/runs', admin);
    expect(runs.body.length).toBeGreaterThanOrEqual(5);
    const details = await t.call('GET', `/api/v1/objects/sync/runs/${r2.runId}`, admin);
    expect(details.body).toMatchObject({ status: 'ok', deactivated: 2 });
    expect(details.body.changes.length).toBe(2);
  });

  it('защита от ошибочной выгрузки: пустая или «слишком много деактиваций» — ошибка без изменений', async () => {
    const empty = await run([]);
    expect(empty.status).toBe('error');
    expect(empty.error).toContain('пустая');
    const few = await run(baseFeed().slice(0, 2));
    expect(few.status).toBe('error');
    expect(few.error).toContain('деактивировала бы');
    expect((await obj('AZS-7')).is_active).toBe(true);
    const bad = await syncObjects(t.pool, {
      trigger: 'manual',
      settings: {
        enabled: true,
        url: 'http://x',
        format: 'json',
        token: null,
        time: '03:00',
        maxDeactivateShare: 0.3,
      },
      feed: async () => '<html>',
    });
    expect(bad).toMatchObject({ status: 'error' });
  });

  it('синхронизируемые поля вручную не меняются: правка, деактивация, импорт CSV; прочие объекты — как раньше', async () => {
    const id = (await one<{ id: string }>(`SELECT id FROM service_object WHERE code = 'AZS-1'`)).id;
    const cur = await t.call('GET', `/api/v1/dict/objects/${id}`, admin);
    const rename = await t.call('PATCH', `/api/v1/dict/objects/${id}`, admin, { name: 'Другое имя' });
    expect(rename.status).toBe(400);
    expect(rename.body.message).toContain('синхронизируется');
    // Форма присылает все поля — без изменений синхронизируемых сохранение проходит.
    const same = await t.call('PATCH', `/api/v1/dict/objects/${id}`, admin, {
      code: cur.body.code,
      name: cur.body.name,
      address: cur.body.address,
      enterpriseId: cur.body.enterpriseId,
      externalIds: cur.body.externalIds,
    });
    expect(same.status, JSON.stringify(same.body)).toBe(200);
    expect((await t.call('POST', `/api/v1/dict/objects/${id}/deactivate`, admin)).status).toBe(400);
    const imp = await t.call('POST', '/api/v1/objects/import', admin, {
      csv: 'code;name;address;enterprise_code\nAZS-1;Импорт;;E1\nMAN-1;Ручной;;E1',
    });
    expect(imp.body).toMatchObject({ created: 1, updated: 0 });
    expect(imp.body.errors[0].message).toContain('синхронизируется');
    const man = (await one<{ id: string }>(`SELECT id FROM service_object WHERE code = 'MAN-1'`)).id;
    expect((await t.call('PATCH', `/api/v1/dict/objects/${man}`, admin, { name: 'Ручной 2' })).status).toBe(
      200,
    );
  });

  it('настройки источника: токен шифруется и не отдаётся; плановый запуск — раз в сутки после заданного времени', async () => {
    const s = await t.call('PUT', '/api/v1/objects/sync/settings', admin, {
      enabled: true,
      url: 'http://objects.local/feed.json',
      token: 'feed-secret',
      time: '03:00',
    });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body.token).toBe(SECRET_MASK);
    const stored = await one<{ value: { token: string } }>(
      `SELECT value FROM system_setting WHERE key = 'objects.sync'`,
    );
    expect(openSecret(stored.value.token, TEST_SECRETS_KEY)).toBe('feed-secret');
    // Маска — «не менять».
    await t.call('PUT', '/api/v1/objects/sync/settings', admin, { token: SECRET_MASK, format: 'csv' });
    const after = await one<{ value: { token: string; format: string } }>(
      `SELECT value FROM system_setting WHERE key = 'objects.sync'`,
    );
    expect(after.value).toMatchObject({ token: stored.value.token, format: 'csv' });
    expect(JSON.stringify((await t.call('GET', '/api/v1/settings', admin)).body)).not.toContain(
      'objects.sync',
    );
    expect((await t.call('GET', '/api/v1/objects/sync/settings', op)).status).toBe(403);

    const csvFeed = async () =>
      `code;name;address;enterprise_code;rocketdata\n${baseFeed()
        .concat(item('AZS-7', 'АЗС №7', 'E2'))
        .map((f) => [f.code, f.name, f.address, f.enterprise_code, f.external_ids.rocketdata].join(';'))
        .join('\n')}\n`;
    const early = await runScheduledObjectSync(t.pool, {
      now: new Date('2026-10-01T23:00:00Z'),
      feed: csvFeed,
    });
    expect(early).toMatchObject({ status: 'skipped', reason: 'not_yet' }); // 02:00 по Минску
    const due = new Date('2026-10-02T00:30:00Z'); // 03:30 по Минску
    expect(await runScheduledObjectSync(t.pool, { now: due, feed: csvFeed })).toMatchObject({ status: 'ok' });
    expect(
      await runScheduledObjectSync(t.pool, { now: new Date(due.getTime() + 3600_000), feed: csvFeed }),
    ).toMatchObject({
      status: 'skipped',
      reason: 'done_today',
    });
    await t.call('PUT', '/api/v1/objects/sync/settings', admin, { enabled: false });
    expect(
      await runScheduledObjectSync(t.pool, { now: new Date('2026-10-05T01:00:00Z'), feed: csvFeed }),
    ).toMatchObject({
      reason: 'disabled',
    });
    // Запуск вручную из api: источник недоступен — ошибка в журнале, не 500.
    await t.call('PUT', '/api/v1/objects/sync/settings', admin, { url: 'http://127.0.0.1:9/feed' });
    const manual = await t.call('POST', '/api/v1/objects/sync/run?dryRun=true', admin);
    expect(manual.status).toBe(200);
    expect(manual.body).toMatchObject({ status: 'error', dryRun: true });
  });
});
