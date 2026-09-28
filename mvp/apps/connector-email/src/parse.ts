import type { EmailMeta } from '@cc/contracts';
import { convert } from 'html-to-text';
import type { ParsedMail } from 'mailparser';

export interface ParsedEmail {
  from: string;
  displayName: string | null;
  body: string;
  email: EmailMeta;
  /** Автоответ/рассылка — обращение не создаём (иначе автоответчики зацикливаются с ответами операторов). */
  automatic: boolean;
  attachments: { filename: string; contentType: string; body: Buffer }[];
}

/** Строка, с которой начинается цитата предыдущего письма в ответе клиента. */
const QUOTE_HEADER = [
  /^On .+ wrote:\s*$/i,
  /^.+ (написал|написала|написал\(а\)|пишет):\s*$/i,
  /^-{2,}\s*(Original Message|Исходное сообщение|Пересылаемое сообщение)\s*-{2,}/i,
  /^(From|От|Отправлено|Sent):\s.+/i,
];

/**
 * Текст ответа без цитаты предыдущей переписки: всё начиная с «... написал(а):» / блока «> ...» в конце.
 * Если после отсечения ничего не осталось — возвращается исходный текст (цитата — это и есть сообщение).
 */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (QUOTE_HEADER.some((re) => re.test(line))) {
      cut = i;
      break;
    }
  }
  while (cut > 0 && /^\s*(>.*)?$/.test(lines[cut - 1]!)) cut--;
  let end = cut;
  // Хвостовой блок цитаты «> ...» без заголовка.
  if (cut === lines.length) {
    end = lines.length;
    while (end > 0 && /^\s*(>.*)?$/.test(lines[end - 1]!)) end--;
  }
  const result = lines.slice(0, end).join('\n').trim();
  return result || text.trim();
}

const asArray = (v: string | string[] | undefined): string[] =>
  !v ? [] : Array.isArray(v) ? v : v.split(/\s+/);

export function parseEmail(mail: ParsedMail, ownAddress: string): ParsedEmail | null {
  const sender = mail.from?.value[0];
  const from = sender?.address?.toLowerCase();
  if (!from || from === ownAddress.toLowerCase()) return null;
  const h = mail.headers;
  const autoSubmitted = String(h.get('auto-submitted') ?? 'no').toLowerCase();
  const precedence = String(h.get('precedence') ?? '').toLowerCase();
  const automatic =
    autoSubmitted !== 'no' ||
    ['bulk', 'junk', 'auto_reply', 'list'].includes(precedence) ||
    h.has('x-autoreply') ||
    h.has('x-autorespond');
  const raw = mail.text?.trim() || (mail.html ? convert(mail.html, { wordwrap: false }).trim() : '');
  const references = [...new Set([...asArray(mail.references), ...asArray(mail.inReplyTo)])].filter(Boolean);
  return {
    from,
    displayName: sender?.name?.trim() || null,
    body: stripQuoted(raw).slice(0, 20_000),
    email: { subject: (mail.subject ?? '').slice(0, 500), messageId: mail.messageId ?? null, references },
    automatic,
    attachments: mail.attachments
      .filter((a) => !(a.related && a.contentDisposition === 'inline'))
      .map((a) => ({
        filename: a.filename ?? 'attachment',
        contentType: a.contentType || 'application/octet-stream',
        body: a.content,
      })),
  };
}
