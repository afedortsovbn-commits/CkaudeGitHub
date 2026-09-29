import { describe, expect, it } from 'vitest';
import { makeEvent } from './event';
import { publicEventOf } from './public-api';

const ref = { conversationId: '0190b8c4-0000-7000-8000-000000000001', status: 'closed' };

describe('публичные события webhooks', () => {
  it('conversation.updated разворачивается по action', () => {
    const e = (action: string) =>
      publicEventOf(makeEvent({ type: 'conversation.updated', source: 't', data: { ...ref, action } }))?.type;
    expect(e('closed')).toBe('conversation.closed');
    expect(e('recording_ready')).toBe('recording.ready');
    expect(e('csat')).toBe('csat.received');
    expect(e('accepted')).toBe('conversation.assigned');
    expect(e('offered')).toBe('conversation.updated');
  });

  it('внутренние заметки и служебные поля наружу не уходят', () => {
    const note = makeEvent({
      type: 'conversation.message_created',
      source: 't',
      data: { ...ref, message: { direction: 'note', body: 'секрет' } },
    });
    expect(publicEventOf(note)).toBeNull();
    const t = publicEventOf(
      makeEvent({ type: 'ticket.created', source: 't', data: { ticketId: 'x', notifyUserIds: ['u'] } }),
    );
    expect(t).toEqual({ type: 'ticket.created', data: { ticketId: 'x' } });
    expect(publicEventOf(makeEvent({ type: 'config.changed', source: 't', data: {} }))).toBeNull();
  });
});
