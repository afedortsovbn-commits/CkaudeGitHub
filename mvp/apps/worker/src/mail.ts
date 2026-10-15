import type { MailPolicy, OutgoingMail } from '@cc/domain';
import { LINK_PLACEHOLDER, unsubscribeUrl, withUnsubscribeHtml, withUnsubscribeText } from '@cc/domain';
import type { SendMailOptions } from 'nodemailer';
import { BRAND_LOGO_CID, BRAND_LOGO_PNG } from './brand-logo';

export interface MailSettings {
  from: string;
  /** Адрес системы для ссылок в письмах (PUBLIC_BASE_URL). */
  baseUrl: string;
}

/**
 * Письмо для SMTP: письма ответственным и кураторам — «Важно!» с высоким приоритетом
 * (Importance: High, X-Priority: 1, M-TKT-04). Message-ID стабилен для записи очереди: повторная отправка
 * после сбоя даёт то же письмо, а не новое.
 */
export function buildMessage(
  mail: OutgoingMail,
  s: MailSettings,
  policy: MailPolicy = { copyTo: [] },
): SendMailOptions {
  const link = mail.ticketId ? `${s.baseUrl.replace(/\/$/, '')}/tickets/${mail.ticketId}` : s.baseUrl;
  const body = mail.body.split(LINK_PLACEHOLDER).join(link);
  // Д-013: в каждом письме — фраза про отписку и крупная красная кнопка; копия — на адреса владельца.
  const unsub = unsubscribeUrl(s.baseUrl, mail.unsubscribeToken ?? '');
  const copyTo = policy.copyTo.filter((a) => a.toLowerCase() !== mail.to.toLowerCase());
  return {
    from: s.from,
    to: mail.to,
    ...(copyTo.length ? { bcc: copyTo } : {}),
    subject: mail.subject,
    text: withUnsubscribeText(body, unsub),
    // Д-069: логотип «OMNI» над текстом — вложением письма (внешние картинки почтовые программы блокируют).
    html: withUnsubscribeHtml(body, unsub, { logoSrc: `cid:${BRAND_LOGO_CID}` }),
    attachments: [
      {
        filename: 'omni-logo.png',
        content: BRAND_LOGO_PNG,
        contentType: 'image/png',
        cid: BRAND_LOGO_CID,
        contentDisposition: 'inline',
      },
    ],
    messageId: `<${mail.id}@cc.local>`,
    headers: {
      'List-Unsubscribe': `<${unsub}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      ...(mail.high ? { Importance: 'High', 'X-Priority': '1 (Highest)', 'X-MSMail-Priority': 'High' } : {}),
    },
  };
}
