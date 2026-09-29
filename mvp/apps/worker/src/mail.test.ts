import nodemailer from 'nodemailer';
import { describe, expect, it } from 'vitest';
import { buildMessage } from './mail';

const settings = { from: 'КЦ <cc@example.by>', baseUrl: 'https://cc.example.by/' };

async function raw(mail: Parameters<typeof buildMessage>[0]): Promise<string> {
  const t = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const info = await t.sendMail(buildMessage(mail, settings));
  return (info as unknown as { message: Buffer }).message.toString('utf8').replace(/=\r?\n/g, '');
}

describe('письма тикетов', () => {
  it('высокий приоритет: Importance: High и X-Priority: 1, «Важно!» в теме, ссылка на тикет', async () => {
    const msg = await raw({
      id: '0190a000-0000-7000-8000-000000000001',
      ticketId: 'abc',
      to: 'resp@example.by',
      subject: 'Важно! Тикет №1001: осталось 2 дня',
      body: 'Срок: 05.10.2026\nОткрыть в системе: {{link}}',
      high: true,
    });
    expect(msg).toMatch(/^Importance: High$/m);
    expect(msg).toMatch(/^X-Priority: 1/m);
    expect(msg).toMatch(/^X-MSMail-Priority: High$/im);
    expect(msg).toContain('https://cc.example.by/tickets/abc');
    expect(msg).toContain('Message-ID: <0190a000-0000-7000-8000-000000000001@cc.local>');
    // тема в UTF-8 (кодируется), тело читается
    expect(msg).toMatch(/^Subject: =\?UTF-8\?/m);
  });

  it('обычные письма (согласование) без флагов важности', async () => {
    const msg = await raw({
      id: '0190a000-0000-7000-8000-000000000002',
      ticketId: 'abc',
      to: 'op@example.by',
      subject: 'Тикет №1001 ожидает согласования',
      body: 'Открыть: {{link}}',
      high: false,
    });
    expect(msg).not.toMatch(/^Importance:/m);
    expect(msg).not.toMatch(/^X-Priority:/m);
  });
});
