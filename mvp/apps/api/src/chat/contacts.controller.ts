import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import type { Principal } from '@cc/auth';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { CurrentUser, RequirePerm } from '../auth/guard';
import { APP_CONTEXT, type AppContext } from '../context';
import { audit } from '../lib/audit';
import { one, rows, toApi, withTx } from '../lib/db';
import { ApiError, badRequest, notFound, parse } from '../lib/errors';

const MergeBody = z.object({ duplicateId: z.string().uuid() }).strict();

interface ContactRow {
  id: string;
  display_name: string | null;
  phone: string | null;
  email: string | null;
  segment: string | null;
  note: string | null;
  merged_into_id: string | null;
  anonymized_at: string | null;
}

/**
 * Ручное слияние дублей клиентов (M-CARD-01, Ф12b): идентификаторы в каналах, обращения, согласия и вложения
 * дубля переносятся к основному клиенту, дубль помечается `merged_into_id` и скрывается из поиска. Обращения
 * сохраняют свои id — отчёты и тикеты не меняются. Сессии виджета и соединения realtime, выданные дублю,
 * продолжают работать: api и realtime подставляют основного клиента по `merged_into_id`.
 */
export async function mergeContacts(
  tx: PoolClient,
  mainId: string,
  duplicateId: string,
  actor: { id: string; ip?: string },
): Promise<{ moved: Record<string, number> }> {
  if (mainId === duplicateId) throw badRequest('Выберите другого клиента');
  // Блокировка в порядке id — встречные слияния двух одинаковых пар не взаимоблокируются.
  const { rows: locked } = await tx.query<ContactRow>(
    `SELECT * FROM contact WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
    [[mainId, duplicateId]],
  );
  const main = locked.find((c) => c.id === mainId);
  const dup = locked.find((c) => c.id === duplicateId);
  if (!main || !dup) throw notFound('Клиент');
  if (main.merged_into_id || dup.merged_into_id)
    throw new ApiError(409, 'already_merged', 'Клиент уже объединён с другим');
  if (main.anonymized_at || dup.anonymized_at)
    throw new ApiError(409, 'anonymized', 'Обезличенного клиента объединять нельзя');
  const moved: Record<string, number> = {};
  for (const table of ['contact_identity', 'conversation', 'consent', 'attachment']) {
    const r = await tx.query(`UPDATE ${table} SET contact_id = $1 WHERE contact_id = $2`, [
      mainId,
      duplicateId,
    ]);
    moved[table] = r.rowCount ?? 0;
  }
  // Ранее присоединённые к дублю — сразу к основному (цепочек не бывает: поиск основного — один шаг).
  await tx.query(`UPDATE contact SET merged_into_id = $1 WHERE merged_into_id = $2`, [mainId, duplicateId]);
  // Пустые поля основного дополняются из дубля; заполненные не меняются.
  await tx.query(
    `UPDATE contact m SET display_name = COALESCE(m.display_name, d.display_name), phone = COALESCE(m.phone, d.phone),
       email = COALESCE(m.email, d.email), segment = COALESCE(m.segment, d.segment),
       note = CASE WHEN d.note IS NULL THEN m.note WHEN m.note IS NULL THEN d.note ELSE m.note || E'\\n' || d.note END,
       updated_at = now()
      FROM contact d WHERE m.id = $1 AND d.id = $2`,
    [mainId, duplicateId],
  );
  await tx.query(
    `UPDATE contact SET merged_into_id = $1, merged_at = now(), merged_by = $3, updated_at = now() WHERE id = $2`,
    [mainId, duplicateId, actor.id],
  );
  const pick = (c: ContactRow) => ({ id: c.id, displayName: c.display_name, phone: c.phone, email: c.email });
  await audit(
    tx,
    actor,
    'contact.merge',
    'contact',
    duplicateId,
    { duplicate: pick(dup), main: pick(main) },
    { mergedIntoId: mainId, moved },
    { configChanged: false },
  );
  return { moved };
}

@Controller('api/v1')
@RequirePerm('contacts.merge')
export class ContactsController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  /** Поиск клиента для слияния: имя, телефон, email, идентификатор в канале; объединённые дубли не находятся. */
  @Get('contacts')
  async search(@Query('q') q = '', @Query('exclude') exclude?: string) {
    const term = q.trim();
    if (term.length < 2) return [];
    const list = await rows(
      this.ctx.pool,
      `SELECT c.id, c.display_name, c.phone, c.email, c.created_at,
              (SELECT count(*)::int FROM conversation v WHERE v.contact_id = c.id) AS conversations
         FROM contact c
        WHERE c.merged_into_id IS NULL AND c.anonymized_at IS NULL AND c.id IS DISTINCT FROM $2::uuid
          AND (c.display_name ILIKE $1 OR c.phone ILIKE $1 OR c.email ILIKE $1
               OR EXISTS (SELECT 1 FROM contact_identity i WHERE i.contact_id = c.id AND i.value ILIKE $1
                            AND i.kind NOT IN ('webchat', 'app')))
        ORDER BY c.created_at DESC LIMIT 20`,
      [`%${term}%`, exclude && /^[0-9a-f-]{36}$/i.test(exclude) ? exclude : null],
    );
    return list.map((r) => toApi(r));
  }

  /** Присоединить дубль к клиенту :id (основному). */
  @Post('contacts/:id/merge')
  @HttpCode(200)
  async merge(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const { duplicateId } = parse(MergeBody, body);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Клиент');
    const r = await withTx(this.ctx.pool, (tx) => mergeContacts(tx, id, duplicateId, p));
    const c = await one(this.ctx.pool, 'SELECT id, display_name, phone, email FROM contact WHERE id = $1', [
      id,
    ]);
    return { ...toApi(c!), moved: r.moved };
  }
}
