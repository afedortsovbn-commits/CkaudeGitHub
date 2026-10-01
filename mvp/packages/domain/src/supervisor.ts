import { CONVERSATION_EVENTS, type MessageDto } from '@cc/contracts';
import type { PoolClient } from 'pg';
import { appendMessage, emitConversation, loadRef } from './conversations';
import { DomainError } from './tickets';

/**
 * Перехват и подсказки супервизора в текстовых обращениях (Ф14, указания заказчика 01.10, раздел 7). Звонок
 * перехватывается через call-control (`takeoverCall`), чат — здесь: обращение переназначается супервизору.
 */

interface Row {
  id: string;
  status: string;
  assignee_id: string | null;
  channel_kind: string;
}

/**
 * Перехват обращения: переназначение супервизору с записью в истории; событие перевода с признаком перехвата
 * (`takeover`) — для отчётов и журнала, оператору — уведомление (`notifyUserIds`). Из очереди, у бота, предложенное,
 * у оператора — любое незакрытое обращение, кроме идущего звонка (его перехватывают из прослушивания).
 */
export async function takeoverConversation(
  tx: PoolClient,
  conversationId: string,
  o: { userId: string; userName: string },
): Promise<{ fromUserId: string | null }> {
  const { rows } = await tx.query<Row>(
    `SELECT id, status, assignee_id, channel_kind FROM conversation WHERE id = $1 FOR UPDATE`,
    [conversationId],
  );
  const c = rows[0];
  if (!c) throw new DomainError(404, 'not_found', 'Обращение не найдено');
  if (c.status === 'closed') throw new DomainError(409, 'closed', 'Обращение закрыто');
  if (c.status === 'waiting_2nd_line')
    throw new DomainError(409, 'waiting_2nd_line', 'Обращение на 2-й линии — перехват недоступен');
  if (c.assignee_id === o.userId && c.status === 'active')
    throw new DomainError(409, 'already_yours', 'Обращение уже у вас');
  const live = await tx.query(
    `SELECT 1 FROM call WHERE conversation_id = $1 AND state NOT IN ('ended', 'queued', 'ivr')`,
    [conversationId],
  );
  if (live.rowCount)
    throw new DomainError(
      409,
      'live_call',
      'Идёт звонок — перехватите его из прослушивания (кнопка «Перехватить» на панели звонка)',
    );
  const from = c.assignee_id;
  const fromName = from
    ? ((await tx.query<{ full_name: string }>(`SELECT full_name FROM app_user WHERE id = $1`, [from])).rows[0]
        ?.full_name ?? '')
    : '';
  // Предложение другому оператору снимается; бот завершает диалог (дальше — супервизор).
  await tx.query(
    `UPDATE routing_offer SET outcome = 'superseded', decided_at = now() WHERE conversation_id = $1 AND outcome IS NULL`,
    [conversationId],
  );
  await tx.query(
    `UPDATE conversation SET assignee_id = $2, status = 'active', assigned_at = now(), offered_at = NULL,
       bot_wake_at = NULL,
       bot_state = CASE WHEN status = 'bot' THEN COALESCE(bot_state, '{}') || '{"done": true}' ELSE bot_state END,
       version = version + 1, updated_at = now()
     WHERE id = $1`,
    [conversationId, o.userId],
  );
  await appendMessage(tx, {
    conversationId,
    direction: 'system',
    body:
      from && from !== o.userId
        ? `Супервизор ${o.userName} перехватил диалог у оператора ${fromName}`
        : `Супервизор ${o.userName} перехватил диалог`,
    channelKind: c.channel_kind,
    authorUserId: o.userId,
  });
  await emitConversation(tx, CONVERSATION_EVENTS.updated, await loadRef(tx, conversationId), {
    action: 'transferred',
    transferKind: 'user',
    takeover: true,
    byUserId: o.userId,
    fromUserId: from,
    notifyUserIds: from && from !== o.userId ? [from] : [],
  });
  return { fromUserId: from };
}

/**
 * Подсказка оператору в чате: скрытое сообщение (внутренняя заметка с признаком `hint`). Видят назначенный оператор
 * и супервизоры в области; клиенту, во внешний канал, в публичный API и webhooks не уходит; ответом клиенту в
 * отчётах не считается. Оператору — всплывающее уведомление (realtime, событие нового сообщения).
 */
export async function addHint(
  tx: PoolClient,
  conversationId: string,
  o: { userId: string; body: string },
): Promise<MessageDto> {
  const { rows } = await tx.query<Row>(
    `SELECT id, status, assignee_id, channel_kind FROM conversation WHERE id = $1 FOR UPDATE`,
    [conversationId],
  );
  const c = rows[0];
  if (!c) throw new DomainError(404, 'not_found', 'Обращение не найдено');
  if (c.status === 'closed') throw new DomainError(409, 'closed', 'Обращение закрыто');
  if (!c.assignee_id || !['active', 'offered'].includes(c.status))
    throw new DomainError(409, 'no_assignee', 'Обращение не назначено оператору — подсказывать некому');
  if (c.assignee_id === o.userId)
    throw new DomainError(409, 'own', 'Обращение ведёте вы — подсказка не нужна');
  const m = await appendMessage(tx, {
    conversationId,
    direction: 'note',
    body: o.body,
    channelKind: c.channel_kind,
    authorUserId: o.userId,
    meta: { hint: true },
  });
  return m!;
}
