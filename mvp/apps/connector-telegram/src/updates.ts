import type { TgUpdate } from './telegram-api';

export interface ParsedUpdate {
  externalId: string;
  chatId: string;
  displayName: string | null;
  body: string;
  files: { fileId: string; filename: string; contentType: string }[];
}

/**
 * Update Telegram → нормализованное входящее (чистая функция, покрыта тестами).
 * Только личные сообщения боту; служебная команда /start (нажатие «Начать») обращение не создаёт.
 * externalId включает канал: update_id уникален только в пределах одного бота.
 */
export function parseUpdate(u: TgUpdate, channelId: string): ParsedUpdate | null {
  const m = u.message;
  if (!m || m.chat.type !== 'private') return null;
  const body = (m.text ?? m.caption ?? '').trim();
  if (/^\/start(\s|$)/.test(body)) return null;
  const files: ParsedUpdate['files'] = [];
  const photo = m.photo?.at(-1);
  if (photo) files.push({ fileId: photo.file_id, filename: `photo_${m.message_id}.jpg`, contentType: 'image/jpeg' });
  if (m.document)
    files.push({
      fileId: m.document.file_id,
      filename: m.document.file_name ?? `file_${m.message_id}`,
      contentType: m.document.mime_type ?? 'application/octet-stream',
    });
  if (!body && !files.length) return null;
  const f = m.from;
  const name = [f?.first_name, f?.last_name].filter(Boolean).join(' ') || (f?.username ? `@${f.username}` : null);
  return {
    externalId: `${channelId}:${u.update_id}`,
    chatId: String(m.chat.id),
    displayName: name,
    body,
    files,
  };
}
