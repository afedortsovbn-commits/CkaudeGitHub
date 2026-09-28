/** Интеграционные тесты ACD (Ф3) на реальной PostgreSQL: назначение, отказ, перелив, конкурентность. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assignQueued, handleOfferTimeout } from '../assign';
import { sweepOverflow } from '../sweep';
import { ADMIN_URL, createTestDb } from './setup';

describe.skipIf(!ADMIN_URL)('Маршрутизация (ACD), Ф3', () => {
  // Своя БД на каждый тест: assignQueued обрабатывает очередь глобально (как в реальном router),
  // общая БД на всё describe создавала бы гонку между тестами за один и тот же пакет обращений.
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeEach(async () => (t = await createTestDb()), 60_000);
  afterEach(async () => t?.cleanup());

  const noopOnOffer = async () => undefined;

  it('3 оператора, 20 обращений: распределяются по ёмкости, каждое — не более чем одному', async () => {
    await t.pool.query(`UPDATE system_setting SET value = '3' WHERE key = 'operator.max_chats'`);
    const q = await t.queue({ name: 'Общая-20' });
    const ch = await t.channel(q);
    const contact = await t.contact();
    const ops = [await t.operator(q), await t.operator(q), await t.operator(q)];
    const convs: string[] = [];
    for (let i = 0; i < 20; i++) convs.push(await t.queuedConversation(q, ch, contact));

    let totalAssigned = 0;
    for (let i = 0; i < 30; i++) {
      const n = await assignQueued(t.pool, { maxChatsFallback: 5, batchSize: 50 }, noopOnOffer);
      totalAssigned += n;
      if (n === 0) break;
    }
    // Ёмкость: 3 оператора × 3 чата = 9; остальные 11 ждут (снимут капасити accept/close — вне рамок теста).
    expect(totalAssigned).toBe(9);

    const offered = await t.pool.query(
      `SELECT assignee_id, count(*)::int AS n FROM conversation WHERE id = ANY($1) AND status = 'offered' GROUP BY assignee_id`,
      [convs],
    );
    expect(offered.rows.length).toBe(3);
    for (const r of offered.rows) {
      expect(ops).toContain(r.assignee_id);
      expect(r.n).toBe(3);
    }
    // Каждое обращение назначено не более чем одному оператору (ровно одна запись предложения).
    const offers = await t.pool.query<{ conversation_id: string; n: number }>(
      `SELECT conversation_id, count(*)::int AS n FROM routing_offer WHERE conversation_id = ANY($1) GROUP BY conversation_id`,
      [convs],
    );
    expect(offers.rows.every((r) => r.n === 1)).toBe(true);
  });

  it('отказ от предложения: обращение не предлагается повторно тому же оператору', async () => {
    const q = await t.queue({ name: 'Отказ' });
    const ch = await t.channel(q);
    const contact = await t.contact();
    const opA = await t.operator(q);
    const opB = await t.operator(q);
    const conv = await t.queuedConversation(q, ch, contact);

    await assignQueued(t.pool, { maxChatsFallback: 5, batchSize: 10 }, noopOnOffer);
    const first = await t.pool.query<{ assignee_id: string }>(
      `SELECT assignee_id FROM conversation WHERE id = $1`,
      [conv],
    );
    const firstAssignee = first.rows[0]!.assignee_id;
    expect([opA, opB]).toContain(firstAssignee);

    // Оператор отклоняет предложение — то же самое действие делает эндпойнт /conversations/:id/decline.
    const offer = await t.pool.query<{ id: string }>(
      `SELECT id FROM routing_offer WHERE conversation_id = $1 AND outcome IS NULL`,
      [conv],
    );
    await t.pool.query(`UPDATE routing_offer SET outcome = 'declined', decided_at = now() WHERE id = $1`, [
      offer.rows[0]!.id,
    ]);
    await t.pool.query(
      `UPDATE conversation SET status = 'queued', assignee_id = NULL, offered_at = NULL WHERE id = $1`,
      [conv],
    );

    await assignQueued(t.pool, { maxChatsFallback: 5, batchSize: 10 }, noopOnOffer);
    const second = await t.pool.query<{ assignee_id: string; status: string }>(
      `SELECT assignee_id, status FROM conversation WHERE id = $1`,
      [conv],
    );
    expect(second.rows[0]!.status).toBe('offered');
    expect(second.rows[0]!.assignee_id).not.toBe(firstAssignee);
  });

  it('таймаут принятия (pg-boss): обращение возвращается в очередь и получает новое предложение', async () => {
    const q = await t.queue({ name: 'Таймаут' });
    const ch = await t.channel(q);
    const contact = await t.contact();
    await t.operator(q);
    const opB = await t.operator(q);
    const conv = await t.queuedConversation(q, ch, contact);
    await assignQueued(t.pool, { maxChatsFallback: 5, batchSize: 10 }, noopOnOffer);
    const offer = await t.pool.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM routing_offer WHERE conversation_id = $1 AND outcome IS NULL`,
      [conv],
    );

    await handleOfferTimeout(t.pool, { conversationId: conv, offerId: offer.rows[0]!.id });

    const afterTimeout = await t.pool.query<{ status: string; assignee_id: string | null }>(
      `SELECT status, assignee_id FROM conversation WHERE id = $1`,
      [conv],
    );
    expect(afterTimeout.rows[0]).toMatchObject({ status: 'queued', assignee_id: null });
    const outcome = await t.pool.query<{ outcome: string }>(
      `SELECT outcome FROM routing_offer WHERE id = $1`,
      [offer.rows[0]!.id],
    );
    expect(outcome.rows[0]!.outcome).toBe('timeout');

    // Повторный тик находит нового кандидата (тот же оператор тоже подходит — таймаут не «отказ»).
    const n = await assignQueued(t.pool, { maxChatsFallback: 5, batchSize: 10 }, noopOnOffer);
    expect(n).toBe(1);
    void opB;
  });

  it('перелив в резервную группу по истечении времени ожидания', async () => {
    const reserve = await t.queue({ name: 'Резерв' });
    const primary = await t.queue({ name: 'Приоритетная', overflowQueueId: reserve, overflowAfterS: 5 });
    const ch = await t.channel(primary);
    const contact = await t.contact();
    const fresh = await t.queuedConversation(primary, ch, contact, { ageS: 0 });
    const stale = await t.queuedConversation(primary, ch, contact, { ageS: 30 });

    const moved = await sweepOverflow(t.pool);
    expect(moved).toBe(1);
    const freshRow = await t.pool.query<{ queue_id: string }>(
      `SELECT queue_id FROM conversation WHERE id = $1`,
      [fresh],
    );
    const staleRow = await t.pool.query<{ queue_id: string }>(
      `SELECT queue_id FROM conversation WHERE id = $1`,
      [stale],
    );
    expect(freshRow.rows[0]!.queue_id).toBe(primary);
    expect(staleRow.rows[0]!.queue_id).toBe(reserve);
  });

  it('два экземпляра router не назначают одно обращение дважды (конкурентный тик)', async () => {
    const q = await t.queue({ name: 'Конкурентность' });
    const ch = await t.channel(q);
    const contact = await t.contact();
    const ops = await Promise.all(Array.from({ length: 5 }, () => t.operator(q)));
    const convs = await Promise.all(Array.from({ length: 30 }, () => t.queuedConversation(q, ch, contact)));

    // Пять «экземпляров router» тикают одновременно по одной и той же очереди обращений.
    await Promise.all(
      Array.from({ length: 5 }, () =>
        assignQueued(t.pool, { maxChatsFallback: 5, batchSize: 30 }, noopOnOffer),
      ),
    );

    const offers = await t.pool.query<{ conversation_id: string; n: number }>(
      `SELECT conversation_id, count(*)::int AS n FROM routing_offer WHERE conversation_id = ANY($1) GROUP BY conversation_id`,
      [convs],
    );
    expect(offers.rows.every((r) => r.n === 1)).toBe(true);
    const perOperator = await t.pool.query<{ assignee_id: string; n: number }>(
      `SELECT assignee_id, count(*)::int AS n FROM conversation WHERE id = ANY($1) AND status = 'offered' GROUP BY assignee_id`,
      [convs],
    );
    for (const r of perOperator.rows) expect(r.n).toBeLessThanOrEqual(5);
    void ops;
  });
});
