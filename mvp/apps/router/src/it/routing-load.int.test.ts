/** Интеграционные тесты режима «по загрузке» (Д-017) на реальной PostgreSQL: ёмкость, правила выбора, ранги. */
import { newId } from '@cc/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assignQueued } from '../assign';
import { ADMIN_URL, createTestDb } from './setup';

describe.skipIf(!ADMIN_URL)('Распределение «по загрузке» (Д-017)', () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeEach(async () => {
    t = await createTestDb();
    await t.pool.query(`UPDATE system_setting SET value = '{"mode":"load"}' WHERE key = 'routing.policy'`);
  }, 60_000);
  afterEach(async () => t?.cleanup());

  const noop = async () => undefined;
  const tick = () => assignQueued(t.pool, { maxChatsFallback: 5, batchSize: 20 }, noop);
  const st = async (id: string) =>
    (await t.pool.query(`SELECT status, assignee_id FROM conversation WHERE id = $1`, [id])).rows[0];

  /** Чат в работе у оператора; последнее сообщение — от клиента (ждёт ответа) или от оператора. */
  async function activeChat(queue: string, channel: string, contact: string, op: string, last: 'in' | 'out') {
    const id = await t.queuedConversation(queue, channel, contact);
    await t.pool.query(`UPDATE conversation SET status = 'active', assignee_id = $2 WHERE id = $1`, [id, op]);
    await t.pool.query(
      `INSERT INTO message (id, conversation_id, seq, direction, body, channel_kind, sent_at)
       VALUES ($1, $2, 1, $3, 'текст', 'webchat', now())`,
      [newId(), id, last],
    );
    return id;
  }

  it('чат — оператору с большей свободной ёмкостью; без 40 свободных единиц чат не предлагается', async () => {
    const q = await t.queue({ name: 'Чаты' });
    const ch = await t.channel(q);
    const contact = await t.contact();
    const a = await t.operator(q);
    const b = await t.operator(q);
    // A: два чата с ожиданием ответа (80 занято, 20 свободно) — чат ему не положен; B: один чат, где клиент молчит
    // (10 занято, 90 свободно).
    await activeChat(q, ch, contact, a, 'in');
    await activeChat(q, ch, contact, a, 'in');
    await activeChat(q, ch, contact, b, 'out');
    const c1 = await t.queuedConversation(q, ch, contact);
    expect(await tick()).toBe(1);
    expect(await st(c1)).toMatchObject({ status: 'offered', assignee_id: b });
    // B: 10 + 40 (предложенный чат) = 50 занято, свободно 50 — ещё один чат можно; после него 90 — нельзя.
    const c2 = await t.queuedConversation(q, ch, contact);
    expect(await tick()).toBe(1);
    expect(await st(c2)).toMatchObject({ status: 'offered', assignee_id: b });
    const c3 = await t.queuedConversation(q, ch, contact);
    expect(await tick()).toBe(0);
    expect((await st(c3)).status).toBe('queued');
  });

  it('звонок — оператору с меньшим числом чатов; занятый звонком или в постобработке не получает звонок', async () => {
    const q = await t.queue({ name: 'Голос', channels: ['voice', 'webchat'] });
    const ch = await t.channel(q);
    const contact = await t.contact();
    const a = await t.operator(q);
    const b = await t.operator(q);
    const c = await t.operator(q);
    await activeChat(q, ch, contact, a, 'in'); // у A один чат, у B — ни одного, у C — ни одного, но постобработка
    await t.pool.query(
      `UPDATE agent_status SET status = 'wrap_up', wrap_up_until = now() + interval '1 minute' WHERE user_id = $1`,
      [c],
    );
    const v1 = await t.queuedConversation(q, ch, contact, { kind: 'voice', ageS: 20 });
    expect(await tick()).toBe(1);
    expect(await st(v1)).toMatchObject({ status: 'offered', assignee_id: b });
    // Звонок B принят и идёт: следующий звонок — A (у него чат, но он без звонка); C всё ещё в постобработке.
    await t.pool.query(`UPDATE conversation SET status = 'active' WHERE id = $1`, [v1]);
    await t.pool.query(
      `INSERT INTO call (id, conversation_id, direction, node, state, client_channel, agent_channel, agent_user_id)
       VALUES (gen_random_uuid(), $1, 'in', 'asterisk-1', 'talking', 'c1', 'a1', $2)`,
      [v1, b],
    );
    const v2 = await t.queuedConversation(q, ch, contact, { kind: 'voice', ageS: 10 });
    expect(await tick()).toBe(1);
    expect(await st(v2)).toMatchObject({ status: 'offered', assignee_id: a });
    // Оператор со звонком (100 занято) чат не получает.
    const chat = await t.queuedConversation(q, ch, contact);
    await t.pool.query(`UPDATE agent_status SET status = 'offline' WHERE user_id = ANY($1)`, [[a, c]]);
    expect(await tick()).toBe(0);
    expect((await st(chat)).status).toBe('queued');
  });

  it('неспешная очередь (почта, отзывы) не назначается сама; негативный отзыв после старения — при pushUrgent', async () => {
    const q = await t.queue({ name: 'Неспешные', channels: ['email', 'review', 'webchat'] });
    const ch = await t.channel(q);
    const contact = await t.contact();
    const op = await t.operator(q);
    const mail = await t.queuedConversation(q, ch, contact, { kind: 'email' });
    const negative = await t.queuedConversation(q, ch, contact, { kind: 'review', ageS: 3600 });
    await t.pool.query(
      `UPDATE conversation SET is_urgent = true, due_at = now() + interval '10 minutes' WHERE id = $1`,
      [negative],
    );
    expect(await tick()).toBe(0);
    expect((await st(mail)).status).toBe('queued');
    expect((await st(negative)).status).toBe('queued');
    // Чат при этом назначается.
    const chat = await t.queuedConversation(q, ch, contact);
    expect(await tick()).toBe(1);
    expect(await st(chat)).toMatchObject({ status: 'offered', assignee_id: op });
    // pushUrgent: состарившийся негативный отзыв (ранг 4 → 3) назначается; почта — нет.
    await t.pool.query(
      `UPDATE system_setting SET value = '{"mode":"load","load":{"pushUrgent":true}}' WHERE key = 'routing.policy'`,
    );
    expect(await tick()).toBe(1);
    expect(await st(negative)).toMatchObject({ status: 'offered', assignee_id: op });
    expect((await st(mail)).status).toBe('queued');
  });
});
