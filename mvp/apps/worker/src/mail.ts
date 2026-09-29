import type { OutgoingMail } from '@cc/domain';
import { LINK_PLACEHOLDER } from '@cc/domain';
import type { SendMailOptions } from 'nodemailer';

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
export function buildMessage(mail: OutgoingMail, s: MailSettings): SendMailOptions {
  const link = mail.ticketId ? `${s.baseUrl.replace(/\/$/, '')}/tickets/${mail.ticketId}` : s.baseUrl;
  return {
    from: s.from,
    to: mail.to,
    subject: mail.subject,
    text: mail.body.split(LINK_PLACEHOLDER).join(link),
    messageId: `<${mail.id}@cc.local>`,
    ...(mail.high
      ? { headers: { Importance: 'High', 'X-Priority': '1 (Highest)', 'X-MSMail-Priority': 'High' } }
      : {}),
  };
}
