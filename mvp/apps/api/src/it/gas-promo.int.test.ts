/** Д-019 «Акция по газу» и Д-020 сроки по каналам: заявление через внешний API, тема и срок, вложения, похожие обращения, отчёт. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_GAS_KEY, GAS_TOPIC_ID, seedGasDemo } from '../cli/gas-demo-seed';
import { withTx } from '../lib/db';
import { ADMIN_URL, createTestApp } from './setup';

describe.skipIf(!ADMIN_URL)('Акция по газу (Д-019, Д-020)', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let admin: string;
  let op: string;
  let channelId: string;
  beforeAll(async () => {
    t = await createTestApp();
    expect(await withTx(t.pool, (tx) => seedGasDemo(tx))).toBe(true);
    channelId = (
      await t.pool.query(`SELECT id FROM channel WHERE config ->> 'topic_id' = $1`, [GAS_TOPIC_ID])
    ).rows[0].id;
    admin = await t.login('admin@test.local');
    op = await t.login('operator1@demo.local');
  }, 60_000);
  afterAll(async () => t?.cleanup());

  const inbound = (externalId: string, fields: Record<string, string>, attachments?: unknown[]) =>
    t.call('POST', '/api/v1/ext/inbound', DEMO_GAS_KEY, {
      externalId,
      contact: { externalId: `lk-${externalId}`, name: fields.full_name },
      text: '',
      fields,
      ...(attachments ? { attachments } : {}),
    });
  const conv = async (id: string) =>
    (
      await t.pool.query(
        `SELECT topic_id, topic_path, due_at, status, fields FROM conversation WHERE id = $1`,
        [id],
      )
    ).rows[0];

  it('заявление по ключу канала получает тему «Акция по газу», поля, вложение и срок 2 рабочих дня', async () => {
    const r = await inbound(
      'gas-1',
      {
        card_number: '2000 0116 00000',
        full_name: 'Иванов Иван Иванович',
        sto_name: 'ИП Жосан Е.В.',
        sto_region: 'Брестская',
        plate: '0000OB1',
        install_date: '2026-09-11',
      },
      [
        {
          filename: 'заявление.txt',
          contentType: 'text/plain',
          base64: Buffer.from('заявление').toString('base64'),
        },
      ],
    );
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const c = await conv(r.body.conversationId);
    expect(c.topic_id).toBe(GAS_TOPIC_ID);
    expect(c.topic_path).toEqual([GAS_TOPIC_ID]);
    expect(c.status).toBe('queued');
    expect(c.fields.card_number).toBe('2000 0116 00000');
    // 2 рабочих дня — не меньше 47 часов (с пятницы — больше).
    const dueH = (new Date(c.due_at).getTime() - Date.now()) / 3600_000;
    expect(dueH).toBeGreaterThan(47);
    expect(dueH).toBeLessThan(5 * 24);
    const m = await t.pool.query(
      `SELECT attachments FROM message WHERE conversation_id = $1 AND direction = 'in'`,
      [r.body.conversationId],
    );
    expect(m.rows[0].attachments).toHaveLength(1);
    expect(m.rows[0].attachments[0].filename).toBe('заявление.txt');
    const a = await t.pool.query(`SELECT conversation_id FROM attachment WHERE id = $1`, [
      m.rows[0].attachments[0].id,
    ]);
    expect(a.rows[0].conversation_id).toBe(r.body.conversationId);
    // Поля темы с отметкой «проверять на повтор».
    const defs = await t.call('GET', `/api/v1/topics/${GAS_TOPIC_ID}/effective-fields`, op);
    expect(
      defs.body
        .filter((f: { checkDuplicates: boolean }) => f.checkDuplicates)
        .map((f: { key: string }) => f.key),
    ).toEqual(['card_number', 'full_name', 'plate']);
  });

  it('повторное заявление по той же карте — предупреждение о похожих обращениях; «Скидка: Да» и закрытие; отчёт', async () => {
    const r = await inbound('gas-2', {
      card_number: '2000-0116-00000',
      full_name: 'Петров Пётр Петрович',
      sto_name: 'ИП Жосан Е.В.',
      sto_region: 'Брестская',
      plate: '1111AA7',
      install_date: '2026-10-01',
    });
    expect(r.status).toBe(202);
    const id = r.body.conversationId as string;
    const d = await t.call('GET', `/api/v1/conversations/${id}/duplicates`, op);
    expect(d.status).toBe(200);
    expect(d.body.matches).toHaveLength(1);
    expect(d.body.matches[0].matched).toEqual(['card_number']);
    expect(d.body.keys.map((k: { key: string }) => k.key)).toContain('card_number');
    // Оператор берёт заявление, присваивает скидку и закрывает (как кнопка «Скидка присвоена — закрыть»).
    expect((await t.call('POST', `/api/v1/conversations/${id}/take`, op)).status).toBe(200);
    const disp = (await t.call('GET', '/api/v1/dict/dispositions', op)).body.find(
      (x: { code: string }) => x.code === 'resolved',
    ).id;
    const patched = await t.call('PATCH', `/api/v1/conversations/${id}`, op, {
      fields: { ...(await conv(id)).fields, discount: 'Да' },
    });
    expect(patched.status).toBe(200);
    const closed = await t.call('POST', `/api/v1/conversations/${id}/close`, op, { dispositionId: disp });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect((await conv(id)).status).toBe('closed');
    const rep = await t.call('GET', '/api/v1/reports/gas-promo', admin);
    expect(rep.status).toBe(200);
    expect(rep.body.columns.map((c: { key: string }) => c.key)).toContain('card_number');
    const rows = rep.body.rows as { card_number: string; discount: string | null; status: string }[];
    expect(rows).toHaveLength(2);
    expect(rows.find((x) => x.discount === 'Да')?.status).toBe('закрыто');
  });

  it('срок по каналу задаёт администратор или супервизор (часы или рабочие дни); оператору — нельзя', async () => {
    expect((await t.call('GET', '/api/v1/routing/due', op)).status).toBe(403);
    const sup = await t.login('supervisor@demo.local');
    const list = await t.call('GET', '/api/v1/routing/due', sup);
    expect(list.status).toBe(200);
    expect(list.body.channels.find((c: { id: string }) => c.id === channelId)).toMatchObject({
      businessDays: 2,
      hours: null,
    });
    const put = await t.call('PUT', '/api/v1/routing/due', admin, {
      byChannel: { [channelId]: { businessDays: null, hours: 5 } },
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.channels.find((c: { id: string }) => c.id === channelId)).toMatchObject({
      businessDays: null,
      hours: 5,
    });
    const r = await inbound('gas-3', { card_number: '3000', full_name: 'Сидоров С.С.', plate: '2222BB7' });
    const dueH = (new Date((await conv(r.body.conversationId)).due_at).getTime() - Date.now()) / 3600_000;
    expect(dueH).toBeGreaterThan(4.9);
    expect(dueH).toBeLessThan(5.1);
  });
});
