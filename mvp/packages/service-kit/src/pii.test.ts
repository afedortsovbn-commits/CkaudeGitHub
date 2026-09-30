import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger';
import { maskPii, maskPiiDeep } from './pii';

describe('маскирование ПДн в журналах (M-NFR-07)', () => {
  it('телефоны и email в строке маскируются, UUID и даты — нет', () => {
    expect(maskPii('звонок с +375 29 123-45-67 принят')).toBe('звонок с +***67 принят');
    expect(maskPii('номер 80291234567')).toBe('номер ***67');
    expect(maskPii('письмо от ivan.petrov@mail.by')).toBe('письмо от i***@mail.by');
    const id = '00000000-0000-7000-8000-000000000001';
    expect(maskPii(`обращение ${id} в 2026-09-30T10:15:00.123Z`)).toBe(
      `обращение ${id} в 2026-09-30T10:15:00.123Z`,
    );
    expect(maskPii('ожидание 1500 мс, очередь 12')).toBe('ожидание 1500 мс, очередь 12');
    expect(maskPii('Key (value)=(+375291234567) already exists.')).toBe(
      'Key (value)=(+***67) already exists.',
    );
  });
  it('поля объекта: тексты и имена скрываются, идентификаторы маскируются, остальное сохраняется', () => {
    expect(
      maskPiiDeep({
        conversationId: '00000000-0000-7000-8000-000000000001',
        body: 'Мой номер +375291234567, я Иван',
        contact: { displayName: 'Иван Петров', phone: '+375291234567', email: 'a@b.by' },
        identity: { kind: 'phone', value: '+375 (29) 123-45-67' },
        status: { from: 'queued', to: 'active' },
        waitMs: 1500,
        err: 'duplicate key: ivan@x.by',
      }),
    ).toEqual({
      conversationId: '00000000-0000-7000-8000-000000000001',
      body: '[скрыто: 31 симв.]',
      contact: { displayName: '[скрыто: 11 симв.]', phone: '+***67', email: 'a***@b.by' },
      identity: { kind: 'phone', value: '+***67' },
      status: { from: 'queued', to: 'active' },
      waitMs: 1500,
      err: 'duplicate key: i***@x.by',
    });
  });
  it('логгер сервиса маскирует сообщение, поля и ошибки; LOG_PII=1 — без маскирования', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _e, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const direct = createLoggerTo(sink);
    direct.info({ phone: '+375291234567', err: new Error('нет клиента a@b.by') }, 'вызов с 375291234567');
    const rec = JSON.parse(lines.at(-1)!);
    expect(rec.msg).toBe('вызов с ***67');
    expect(rec.phone).toBe('+***67');
    expect(JSON.stringify(rec.err)).toContain('a***@b.by');
    expect(JSON.stringify(rec)).not.toContain('291234567');
    const plain = createLoggerTo(sink, false);
    plain.info({ phone: '+375291234567' }, 'x');
    expect(JSON.parse(lines.at(-1)!).phone).toBe('+375291234567');
  });
});

/** createLogger с выводом в поток — для проверки итоговых строк. */
function createLoggerTo(stream: Writable, maskPiiOn = true) {
  return createLogger({ service: 't', version: '1', maskPii: maskPiiOn, stream });
}
