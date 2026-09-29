import { inScope, type Principal } from '@cc/auth';
import type { ConversationRef, EventEnvelope, MessageDto } from '@cc/contracts';

export type Peer =
  | { kind: 'operator'; principal: Principal }
  | { kind: 'client'; contactId: string; channelId: string };

type ConvEvent = Omit<EventEnvelope, 'data'> & {
  data: ConversationRef & { message?: MessageDto; action?: string };
};

/**
 * Что получает подключённый участник по событию обращения (чистая функция — покрыта тестами).
 * Оператор: обращения в своей области видимости или назначенные ему (M-ORG-07).
 * Клиент: только свои диалоги и только исходящие/системные сообщения — внутренние заметки не уходят клиенту.
 */
export function deliver(peer: Peer, e: ConvEvent): Record<string, unknown> | null {
  const d = e.data;
  if (peer.kind === 'operator') {
    const p = peer.principal;
    if (!p.permissions.has('conversations.work')) return null;
    const visible =
      d.assigneeId === p.id ||
      inScope(p.scope, {
        enterpriseId: d.enterpriseId,
        departmentId: d.departmentId,
        topicPath: d.topicPath,
      });
    return visible ? { type: 'event', event: e.type, data: d } : null;
  }
  if (d.contactId !== peer.contactId) return null;
  if (e.type === 'conversation.message_created') {
    const m = d.message;
    if (!m || m.direction === 'note') return null;
    return { type: 'message', message: m };
  }
  if (e.type === 'conversation.updated')
    return { type: 'status', conversationId: d.conversationId, status: d.status };
  return null;
}

/**
 * События тикетов 2-й линии (Ф8): только тем, кому адресовано уведомление (`notifyUserIds`) — назначенным,
 * создателю, согласующим. Клиенты их не получают. Оператор по такому событию обновляет колокольчик и списки.
 */
export function deliverTicket(
  peer: Peer,
  e: Omit<EventEnvelope, 'data'> & {
    data: { notifyUserIds?: string[]; ticketId?: string; number?: number; status?: string };
  },
): Record<string, unknown> | null {
  if (peer.kind !== 'operator') return null;
  if (!e.data.notifyUserIds?.includes(peer.principal.id)) return null;
  const { ticketId, number, status } = e.data;
  return { type: 'ticket', event: e.type, data: { ticketId, number, status } };
}
