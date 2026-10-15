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

describe('письма: копии и отписка (Д-013)', () => {
  const mail = {
    id: '0190a000-0000-7000-8000-000000000002',
    ticketId: null,
    to: 'resp@example.by',
    subject: 'Уведомление',
    body: 'Первый абзац.\n\nВторой абзац.',
    high: false,
    unsubscribeToken: 'tok-abc',
  };

  it('в каждом письме — фраза про отписку, красная кнопка и заголовки List-Unsubscribe; копия — на адреса владельца', () => {
    const built = buildMessage(mail, settings, { copyTo: ['A.Fedortsov@beloil.by', 'resp@example.by'] });
    expect(built.bcc).toEqual(['A.Fedortsov@beloil.by']); // сам получатель в копию не дублируется
    const headers = built.headers as Record<string, string>;
    expect(headers['List-Unsubscribe']).toBe('<https://cc.example.by/api/v1/unsubscribe?token=tok-abc>');
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(String(built.html)).toContain('background:#d32f2f');
    expect(String(built.html)).toContain('Отписаться от рассылки');
    expect(String(built.html)).toContain('не подписывались на данные сообщения');
    expect(String(built.html)).toContain('<p style="margin:0 0 12px">Первый абзац.</p>');
    expect(String(built.text)).toContain(
      'Отписаться от рассылки: https://cc.example.by/api/v1/unsubscribe?token=tok-abc',
    );
    expect(String(built.text)).toContain('не подписывались на данные сообщения');
  });

  it('логотип OMNI над текстом — вложением с Content-ID (Д-069)', async () => {
    const built = buildMessage(mail, settings);
    expect(String(built.html)).toContain('<img src="cid:omni-logo@cc.local" alt="OMNI"');
    const att = (built.attachments ?? [])[0];
    expect(att?.cid).toBe('omni-logo@cc.local');
    expect((att?.content as Buffer).subarray(1, 4).toString()).toBe('PNG');
    expect(await raw(mail)).toMatch(/^Content-ID: <omni-logo@cc\.local>$/m);
  });

  it('без адресов копии — без bcc', () => {
    expect(buildMessage(mail, settings).bcc).toBeUndefined();
  });
});
