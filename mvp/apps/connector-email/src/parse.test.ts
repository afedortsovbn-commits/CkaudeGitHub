import { simpleParser } from 'mailparser';
import { describe, expect, it } from 'vitest';
import { parseEmail, stripQuoted } from './parse';

const mail = (headers: string, body: string) =>
  simpleParser(Buffer.from(`${headers.trim()}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`));

describe('stripQuoted', () => {
  it('отсекает цитату после «... написал(а):»', () => {
    expect(
      stripQuoted('Спасибо, всё работает.\n\n28.09.2026, Поддержка написал(а):\n> Попробуйте ещё раз'),
    ).toBe('Спасибо, всё работает.');
  });
  it('отсекает «On ... wrote:» и хвост цитаты «>»', () => {
    expect(stripQuoted('Ok\r\n\r\nOn Mon, Sep 28 support wrote:\r\n> hi')).toBe('Ok');
    expect(stripQuoted('Ответ\n> цитата\n> ещё')).toBe('Ответ');
  });
  it('если после отсечения пусто — остаётся исходный текст', () => {
    expect(stripQuoted('> только цитата')).toBe('> только цитата');
  });
});

describe('parseEmail', () => {
  it('отправитель, имя, тема и цепочка (In-Reply-To + References)', async () => {
    const p = parseEmail(
      await mail(
        `From: "Иван Петров" <Ivan@Example.BY>
To: support@cc.local
Subject: Re: Возврат средств
Message-ID: <c2@example.by>
In-Reply-To: <out1@cc.local>
References: <c1@example.by> <out1@cc.local>`,
        'Добрый день!\nКарта 1234.',
      ),
      'support@cc.local',
    );
    expect(p).toMatchObject({
      from: 'ivan@example.by',
      displayName: 'Иван Петров',
      body: 'Добрый день!\nКарта 1234.',
      automatic: false,
      email: {
        subject: 'Re: Возврат средств',
        messageId: '<c2@example.by>',
        references: ['<c1@example.by>', '<out1@cc.local>'],
      },
    });
  });

  it('автоответ помечается, письмо от собственного адреса ящика пропускается', async () => {
    const auto = parseEmail(
      await mail('From: a@b.by\nSubject: Out of office\nAuto-Submitted: auto-replied', 'Я в отпуске'),
      'support@cc.local',
    );
    expect(auto?.automatic).toBe(true);
    expect(parseEmail(await mail('From: support@cc.local\nSubject: x', 'y'), 'support@cc.local')).toBeNull();
  });

  it('HTML-письмо без текстовой части превращается в текст', async () => {
    const m = await simpleParser(
      Buffer.from(
        'From: a@b.by\r\nSubject: html\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Привет, <b>мир</b></p>',
      ),
    );
    expect(parseEmail(m, 'support@cc.local')?.body).toContain('Привет, мир');
  });
});
