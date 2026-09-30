import type { Principal } from '@cc/auth';
import { describe, expect, it } from 'vitest';
import { deliver, deliverApp, deliverTicket } from './routing';

const E1 = 'e1';
const base = {
  conversationId: 'c1',
  contactId: 'k1',
  channelKind: 'webchat',
  status: 'active',
  queueId: null,
  assigneeId: null as string | null,
  enterpriseId: E1 as string | null,
  departmentId: null,
  topicPath: [],
  isImportant: false,
};
const ev = (type: string, extra: Record<string, unknown> = {}) =>
  ({ id: 'x', type, version: 1, occurredAt: '', source: 't', data: { ...base, ...extra } }) as never;
const op = (rules: Principal['scope']['rules'], all = false, perms = ['conversations.work']): Principal => ({
  id: 'u1',
  sessionId: 's',
  fullName: 'Оп',
  email: '',
  roles: [],
  permissions: new Set(perms),
  scope: { all, rules },
});

describe('deliver', () => {
  it('оператор со «всё» получает событие', () => {
    expect(deliver({ kind: 'operator', principal: op([], true) }, ev('conversation.created'))).not.toBeNull();
  });
  it('оператор вне области не получает, но получает назначенное ему', () => {
    const p = op([{ enterpriseIds: ['e2'], departmentIds: null, topicIds: null }]);
    expect(deliver({ kind: 'operator', principal: p }, ev('conversation.created'))).toBeNull();
    expect(
      deliver({ kind: 'operator', principal: p }, ev('conversation.updated', { assigneeId: 'u1' })),
    ).not.toBeNull();
  });
  it('сотрудник без права работы с обращениями ничего не получает', () => {
    expect(
      deliver({ kind: 'operator', principal: op([], true, ['tickets.work']) }, ev('conversation.created')),
    ).toBeNull();
  });
  it('клиент получает только свои исходящие сообщения, заметки — никогда', () => {
    const client = { kind: 'client' as const, contactId: 'k1', channelId: 'ch' };
    const msg = (direction: string) =>
      ev('conversation.message_created', { message: { id: 'm', direction, body: 'x' } });
    expect(deliver(client, msg('out'))).toMatchObject({ type: 'message' });
    expect(deliver(client, msg('note'))).toBeNull();
    expect(deliver({ ...client, contactId: 'other' }, msg('out'))).toBeNull();
    expect(deliver(client, ev('conversation.updated', { status: 'closed' }))).toEqual({
      type: 'status',
      conversationId: 'c1',
      status: 'closed',
    });
  });
});

describe('deliverTicket (Ф8)', () => {
  const tk = (notify: string[]) =>
    ({
      id: 'x',
      type: 'ticket.assigned',
      version: 1,
      occurredAt: '',
      source: 'tickets',
      data: { ticketId: 't1', number: 1001, status: 'new', notifyUserIds: notify },
    }) as never;

  it('только адресатам уведомления, независимо от области видимости', () => {
    expect(deliverTicket({ kind: 'operator', principal: op([]) }, tk(['u1']))).toEqual({
      type: 'ticket',
      event: 'ticket.assigned',
      data: { ticketId: 't1', number: 1001, status: 'new' },
    });
    expect(deliverTicket({ kind: 'operator', principal: op([], true) }, tk(['u2']))).toBeNull();
  });
  it('клиенты события тикетов не получают', () => {
    expect(deliverTicket({ kind: 'client', contactId: 'k1', channelId: 'c' }, tk(['u1']))).toBeNull();
  });
});

describe('deliverApp (Ф11)', () => {
  const e = {
    id: 'x',
    type: 'app.version',
    version: 1,
    occurredAt: '',
    source: 'release',
    data: { component: 'web' as const, version: 'v2' },
  };
  it('новая версия — всем сотрудникам, клиентам виджета — нет', () => {
    expect(deliverApp({ kind: 'operator', principal: op([], false, []) }, e)).toEqual({
      type: 'app_version',
      component: 'web',
      version: 'v2',
    });
    expect(deliverApp({ kind: 'client', contactId: 'k1', channelId: 'ch' }, e)).toBeNull();
    expect(deliverApp({ kind: 'operator', principal: op([]) }, { ...e, type: 'app.other' })).toBeNull();
  });
});
