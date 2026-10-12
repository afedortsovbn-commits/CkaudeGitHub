import type { Pool, PoolClient } from 'pg';

/**
 * Политика исходящих писем (Д-013, правило владельца от 10.10.2026): копия каждого письма на адреса владельца
 * (`mail.policy.copyTo`), в каждом письме — фраза про отписку и крупная красная кнопка «Отписаться от рассылки»,
 * заголовки List-Unsubscribe. Отписавшемуся сотруднику письма больше не отправляются (ответ «отписаться» на письмо
 * принимает почтовый relay и вызывает POST /api/v1/inbound/unsubscribe).
 */
export interface MailPolicy {
  copyTo: string[];
}

export const UNSUB_PHRASE =
  'Если Вы не подписывались на данные сообщения, пожалуйста, пришлите в ответ слово "отписаться" либо нажмите на кнопку "Отписаться от рассылки".';

export async function loadMailPolicy(db: Pool | PoolClient): Promise<MailPolicy> {
  const r = await db.query<{ value: { copyTo?: unknown } }>(
    `SELECT value FROM system_setting WHERE key = 'mail.policy'`,
  );
  const raw = r.rows[0]?.value?.copyTo;
  const copyTo = Array.isArray(raw)
    ? raw.map((x) => String(x).trim()).filter((x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x))
    : [];
  return { copyTo: [...new Set(copyTo.map((x) => x.toLowerCase()))] };
}

export const unsubscribeUrl = (baseUrl: string, token: string) =>
  `${baseUrl.replace(/\/$/, '')}/api/v1/unsubscribe?token=${encodeURIComponent(token)}`;

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Текстовая версия: тело + фраза и ссылка отписки. */
export function withUnsubscribeText(body: string, url: string): string {
  return `${body}\n\n---\n${UNSUB_PHRASE}\nОтписаться от рассылки: ${url}\n`;
}

/** HTML-версия: абзацы из текста, фраза про отписку и крупная красная кнопка. */
export function withUnsubscribeHtml(body: string, url: string): string {
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  const u = escapeHtml(url);
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;font-size:15px;line-height:1.45;color:#111">
${paragraphs}
<hr style="border:none;border-top:1px solid #ddd;margin:24px 0">
<p style="color:#444;font-size:13px">${escapeHtml(UNSUB_PHRASE)}</p>
<p style="margin:16px 0"><a href="${u}" style="display:inline-block;background:#d32f2f;color:#fff;font-size:18px;font-weight:bold;padding:14px 28px;border-radius:8px;text-decoration:none">Отписаться от рассылки</a></p>
</body></html>`;
}

/** Токены отписки сотрудникам, у которых их ещё нет (нужны для ссылок в письмах). */
export async function ensureUnsubscribeTokens(db: Pool | PoolClient): Promise<void> {
  await db.query(
    `UPDATE app_user SET unsubscribe_token = md5(gen_random_uuid()::text || id::text)
      WHERE unsubscribe_token IS NULL AND id IN (SELECT user_id FROM notification WHERE channel = 'email' AND status = 'pending')`,
  );
}

/** Отписка по токену из письма или по адресу (ответ «отписаться» через relay). Возвращает, нашёлся ли сотрудник. */
export async function markUnsubscribed(
  db: Pool | PoolClient,
  by: { token?: string | null; email?: string | null },
): Promise<boolean> {
  if (!by.token && !by.email) return false;
  const r = await db.query(
    `UPDATE app_user SET email_unsubscribed_at = COALESCE(email_unsubscribed_at, now()), updated_at = now()
      WHERE ($1::text IS NOT NULL AND unsubscribe_token = $1) OR ($2::text IS NOT NULL AND lower(email) = lower($2))`,
    [by.token ?? null, by.email ?? null],
  );
  if (r.rowCount)
    await db.query(
      `UPDATE notification n SET status = 'skipped', last_error = 'сотрудник отписался от писем'
         FROM app_user u WHERE u.id = n.user_id AND n.channel = 'email' AND n.status = 'pending'
          AND (($1::text IS NOT NULL AND u.unsubscribe_token = $1) OR ($2::text IS NOT NULL AND lower(u.email) = lower($2)))`,
      [by.token ?? null, by.email ?? null],
    );
  return (r.rowCount ?? 0) > 0;
}

/** Снова получать письма (из профиля). */
export async function resubscribe(db: Pool | PoolClient, userId: string): Promise<void> {
  await db.query(`UPDATE app_user SET email_unsubscribed_at = NULL, updated_at = now() WHERE id = $1`, [
    userId,
  ]);
}
