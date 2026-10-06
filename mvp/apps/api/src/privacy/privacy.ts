import type { Pool, PoolClient } from 'pg';
import type { Storage } from '../lib/storage';

/**
 * Персональные данные (M-NFR-07, M-ADM-01, [УПР]): сроки хранения записей разговоров и обезличивание клиента
 * и уволенного сотрудника. Строки обращений, звонков и событий остаются (история и отчёты), удаляются файлы
 * и данные, по которым можно установить личность.
 */

export const ERASED_TEXT = '[удалено: обезличивание]';

/**
 * Удаляет файлы записей разговоров старше срока хранения (`recording.retention_days`, по умолчанию 1825 дней — 5 лет,
 * В-11). Сначала файл, затем отметка `deleted_at` — повторный запуск после сбоя доделает недоделанное.
 */
export async function runRecordingRetention(
  pool: Pool,
  storage: Storage,
  now = new Date(),
  batch = 500,
): Promise<{ deleted: number; days: number }> {
  const s = await pool.query<{ v: string | null }>(
    `SELECT value #>> '{}' AS v FROM system_setting WHERE key = 'recording.retention_days'`,
  );
  const days = Number(s.rows[0]?.v) || 1825;
  let deleted = 0;
  for (;;) {
    const { rows } = await pool.query<{ id: string; storage_key: string | null }>(
      `SELECT id, storage_key FROM call_recording
        WHERE deleted_at IS NULL AND created_at < $1::timestamptz - make_interval(days => $2)
        ORDER BY created_at LIMIT $3`,
      [now, days, batch],
    );
    for (const r of rows) {
      if (r.storage_key) await storage.remove(r.storage_key);
      await pool.query(`UPDATE call_recording SET deleted_at = $2 WHERE id = $1`, [r.id, now]);
      deleted++;
    }
    if (rows.length < batch) break;
  }
  return { deleted, days };
}

/** Файлы, которые нужно удалить из хранилища после фиксации транзакции обезличивания. */
export interface ErasedFiles {
  keys: string[];
}

/**
 * Обезличивание клиента (по запросу субъекта ПДн): профиль, идентификаторы в каналах (при новом обращении
 * клиент будет новым), тексты и вложения его сообщений, записи разговоров, поля карточек обращений, адрес и
 * браузер в согласиях; в журнале событий и доставках webhooks — тексты сообщений клиента и контактные данные.
 * Факт согласия (канал, версия, дата) и сами обращения сохраняются. Операторские ответы не меняются.
 */
export async function anonymizeContact(tx: PoolClient, contactId: string): Promise<ErasedFiles> {
  const keys: string[] = [];
  await tx.query(
    `UPDATE contact SET display_name = 'Клиент (обезличен)', phone = NULL, email = NULL, note = NULL, segment = NULL,
            anonymized_at = now(), updated_at = now() WHERE id = $1`,
    [contactId],
  );
  await tx.query(`UPDATE contact_identity SET value = 'anon:' || id::text WHERE contact_id = $1`, [
    contactId,
  ]);
  const convs = `SELECT id FROM conversation WHERE contact_id = $1`;
  await tx.query(
    `UPDATE message SET body = $2, attachments = '[]' WHERE direction = 'in' AND conversation_id IN (${convs})`,
    [contactId, ERASED_TEXT],
  );
  await tx.query(`UPDATE conversation SET fields = '{}' WHERE contact_id = $1`, [contactId]);
  const att = await tx.query<{ storage_key: string }>(
    `UPDATE attachment SET deleted_at = now(), filename = 'удалено'
      WHERE deleted_at IS NULL AND (contact_id = $1 OR (uploaded_by_user IS NULL AND conversation_id IN (${convs})))
      RETURNING storage_key`,
    [contactId],
  );
  keys.push(...att.rows.map((r) => r.storage_key));
  const rec = await tx.query<{ storage_key: string | null }>(
    `UPDATE call_recording SET deleted_at = now() WHERE deleted_at IS NULL AND conversation_id IN (${convs})
      RETURNING storage_key`,
    [contactId],
  );
  keys.push(...rec.rows.flatMap((r) => (r.storage_key ? [r.storage_key] : [])));
  await tx.query(
    `UPDATE call SET from_number = 'скрыт' WHERE direction = 'in' AND conversation_id IN (${convs})`,
    [contactId],
  );
  await tx.query(
    `UPDATE call SET to_number = 'скрыт' WHERE direction = 'out' AND conversation_id IN (${convs})`,
    [contactId],
  );
  await tx.query(`UPDATE consent SET ip = NULL, user_agent = NULL WHERE contact_id = $1`, [contactId]);
  // Журнал событий неизменяем; стирание ПДн — единственное разрешённое изменение (миграция 0013).
  await tx.query(`SET LOCAL cc.pd_erase = 'on'`);
  await tx.query(
    `UPDATE event SET data = jsonb_set(data, '{message,body}', to_jsonb($2::text))
      WHERE data ->> 'contactId' = $1::text AND type = 'conversation.message_created'
        AND data #>> '{message,direction}' = 'in'`,
    [contactId, ERASED_TEXT],
  );
  await tx.query(
    `UPDATE event SET data = data - 'contact' - 'fields'
      WHERE data ->> 'contactId' = $1::text AND (data ? 'contact' OR data ? 'fields')`,
    [contactId],
  );
  await tx.query(`SET LOCAL cc.pd_erase = 'off'`);
  await tx.query(
    `UPDATE webhook_delivery SET payload = jsonb_set(payload, '{data,message,body}', to_jsonb($2::text))
      WHERE payload #>> '{data,contactId}' = $1::text AND payload #>> '{data,message,direction}' = 'in'`,
    [contactId, ERASED_TEXT],
  );
  return { keys };
}

/**
 * Обезличивание уволенного сотрудника (M-ADM-01 [УПР]): ФИО, email, телефон, пароль и 2FA; вход невозможен.
 * Идентификатор остаётся — история обращений, тикетов и отчёты сохраняются под именем «Сотрудник удалён».
 */
export async function anonymizeUser(tx: PoolClient, userId: string): Promise<void> {
  await tx.query(
    `UPDATE app_user SET full_name = 'Сотрудник удалён (' || left(id::text, 8) || ')',
            email = 'deleted-' || id::text || '@anonymized.invalid', phone = NULL, password_hash = NULL,
            can_login = false, totp_secret = NULL, totp_pending_secret = NULL, totp_enabled_at = NULL,
            totp_last_step = NULL, anonymized_at = now(), updated_at = now()
      WHERE id = $1`,
    [userId],
  );
  await tx.query(`UPDATE auth_session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [
    userId,
  ]);
}
