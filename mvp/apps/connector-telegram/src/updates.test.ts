import { describe, expect, it } from 'vitest';
import { parseUpdate } from './updates';

const base = (message: Record<string, unknown>) => ({
  update_id: 42,
  message: { message_id: 7, date: 1, chat: { id: 1001, type: 'private' }, ...message },
});

describe('parseUpdate', () => {
  it('текст личного сообщения → входящее с идентификатором чата и именем', () => {
    const p = parseUpdate(
      base({ text: 'Здравствуйте', from: { id: 1001, first_name: 'Иван', last_name: 'Петров' } }),
      'ch1',
    );
    expect(p).toEqual({
      externalId: 'ch1:42',
      chatId: '1001',
      displayName: 'Иван Петров',
      body: 'Здравствуйте',
      files: [],
    });
  });

  it('фото: берётся самый крупный размер, подпись — текст сообщения', () => {
    const p = parseUpdate(
      base({
        caption: 'чек',
        photo: [{ file_id: 'small' }, { file_id: 'big' }],
        from: { id: 1, username: 'ivan' },
      }),
      'ch1',
    );
    expect(p?.body).toBe('чек');
    expect(p?.displayName).toBe('@ivan');
    expect(p?.files).toEqual([{ fileId: 'big', filename: 'photo_7.jpg', contentType: 'image/jpeg' }]);
  });

  it('документ сохраняет имя и тип файла', () => {
    const p = parseUpdate(
      base({ document: { file_id: 'd1', file_name: 'акт.pdf', mime_type: 'application/pdf' } }),
      'ch1',
    );
    expect(p?.files).toEqual([{ fileId: 'd1', filename: 'акт.pdf', contentType: 'application/pdf' }]);
  });

  it('/start, группы, пустые и не-message обновления пропускаются', () => {
    expect(parseUpdate(base({ text: '/start' }), 'ch1')).toBeNull();
    expect(parseUpdate(base({ text: 'привет', chat: { id: -5, type: 'group' } }), 'ch1')).toBeNull();
    expect(parseUpdate(base({}), 'ch1')).toBeNull();
    expect(parseUpdate({ update_id: 1 }, 'ch1')).toBeNull();
  });

  it('один и тот же update_id у разных ботов — разные externalId', () => {
    expect(parseUpdate(base({ text: 'a' }), 'bot-A')?.externalId).not.toBe(
      parseUpdate(base({ text: 'a' }), 'bot-B')?.externalId,
    );
  });
});
