import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import type { Principal } from '@cc/auth';
import { makeEvent, newId } from '@cc/contracts';
import { enqueueEvent } from '@cc/service-kit';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { CurrentUser, RequirePerm } from '../auth/guard';
import { APP_CONTEXT, type AppContext } from '../context';
import { ApiKeyAuth, CurrentKey, type KeyPrincipal, RequireKeyPerm } from '../ext/api-key';
import { audit } from '../lib/audit';
import { one, rows, toApi, withTx } from '../lib/db';
import { ApiError, notFound, parse } from '../lib/errors';

/**
 * Модерация комментариев к новостям (Д-100). Публичный канал: всё, что опубликовано, видят все читатели новости,
 * поэтому комментарий сначала ждёт решения модератора. Сайт (мобильные сервисы m.belorusneft.by) присылает
 * комментарии по ключу API с правом `comments`, решения получает webhook-событием `comment.moderated` или
 * запросом `GET /ext/comments/decisions?since=`.
 */
const ExtComment = z
  .object({
    externalId: z.string().trim().min(1).max(200),
    newsId: z.string().trim().min(1).max(200),
    newsTitle: z.string().trim().max(500).default(''),
    newsUrl: z.string().trim().url().max(1000).optional(),
    parentExternalId: z.string().trim().max(200).optional(),
    author: z.object({
      name: z.string().trim().max(200).default(''),
      id: z.string().trim().max(200).optional(),
    }),
    text: z.string().trim().min(1, 'Пустой комментарий').max(5000),
    postedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const REJECT_REASONS: Record<string, string> = {
  abuse: 'Оскорбления, нецензурная лексика',
  spam: 'Спам или реклама',
  offtopic: 'Не по теме новости',
  personal: 'Персональные данные',
  illegal: 'Нарушает закон или правила сервиса',
  other: 'Другое',
};
const Reject = z
  .object({
    reason: z.enum(Object.keys(REJECT_REASONS) as [string, ...string[]]),
    note: z.string().trim().max(500).optional(),
  })
  .strict();
const Reply = z
  .object({
    text: z.string().trim().min(1, 'Напишите ответ').max(5000),
    /** Опубликовать и сам комментарий (по умолчанию — да: отвечают на то, что видно читателям). */
    approve: z.boolean().default(true),
  })
  .strict();

const COLS = `c.id, c.source, c.external_id, c.news_id, c.news_title, c.news_url, c.parent_id, c.author_name,
  c.is_official, c.body, c.status, c.reject_reason, c.moderated_at, c.posted_at, c.received_at,
  u.full_name AS moderated_by_name`;

/** Решение модератора — событие для сайта (webhook comment.moderated). */
async function emitModerated(tx: PoolClient, id: string, action: string): Promise<void> {
  const c = await one(tx, `SELECT * FROM news_comment WHERE id = $1`, [id]);
  if (!c) return;
  const parent = c.parent_id
    ? await one<{ external_id: string | null }>(tx, `SELECT external_id FROM news_comment WHERE id = $1`, [
        c.parent_id,
      ])
    : null;
  await enqueueEvent(
    tx,
    makeEvent({
      type: 'comment.moderated',
      source: 'moderation',
      data: {
        action,
        commentId: c.id,
        externalId: c.external_id ?? null,
        newsId: c.news_id,
        parentExternalId: parent?.external_id ?? null,
        status: c.status,
        isOfficial: c.is_official,
        text: c.is_official ? c.body : undefined,
        rejectReason: c.reject_reason ? (REJECT_REASONS[String(c.reject_reason)] ?? c.reject_reason) : null,
        moderatedAt: c.moderated_at,
      },
    }),
  );
}

@Controller('api/v1/ext/comments')
@ApiKeyAuth()
export class ExtCommentsController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  /** Новый комментарий на модерацию; повтор с тем же externalId не создаёт дубля. */
  @Post()
  @HttpCode(202)
  @RequireKeyPerm('comments')
  async submit(@CurrentKey() k: KeyPrincipal, @Body() body: unknown) {
    const b = parse(ExtComment, body);
    return withTx(this.ctx.pool, async (tx) => {
      const parent = b.parentExternalId
        ? await one<{ id: string }>(
            tx,
            `SELECT id FROM news_comment WHERE source = $1 AND external_id = $2`,
            ['m.belorusneft.by', b.parentExternalId],
          )
        : null;
      const r = await one<{ id: string; status: string; inserted: boolean }>(
        tx,
        `INSERT INTO news_comment (id, api_key_id, external_id, news_id, news_title, news_url, parent_id, author_name,
                                   author_external_id, body, posted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11::timestamptz, now()))
         ON CONFLICT (source, external_id) WHERE external_id IS NOT NULL DO UPDATE SET external_id = EXCLUDED.external_id
         RETURNING id, status, (xmax = 0) AS inserted`,
        [
          newId(),
          k.keyId,
          b.externalId,
          b.newsId,
          b.newsTitle,
          b.newsUrl ?? null,
          parent?.id ?? null,
          b.author.name,
          b.author.id ?? null,
          b.text,
          b.postedAt ?? null,
        ],
      );
      return { id: r!.id, status: r!.status, duplicate: !r!.inserted };
    });
  }

  /** Решения модераторов после указанного времени (для сайта без webhook). */
  @Get('decisions')
  @RequireKeyPerm('comments')
  async decisions(@Query('since') since?: string) {
    const list = await rows(
      this.ctx.pool,
      `SELECT c.id, c.external_id, c.news_id, p.external_id AS parent_external_id, c.status, c.is_official,
              CASE WHEN c.is_official THEN c.body END AS text, c.reject_reason, c.moderated_at
         FROM news_comment c LEFT JOIN news_comment p ON p.id = c.parent_id
        WHERE c.moderated_at IS NOT NULL AND ($1::timestamptz IS NULL OR c.moderated_at > $1::timestamptz)
        ORDER BY c.moderated_at LIMIT 500`,
      [since || null],
    );
    return list.map((r) => {
      const x = toApi(r) as Record<string, unknown>;
      if (x.rejectReason) x.rejectReason = REJECT_REASONS[String(x.rejectReason)] ?? x.rejectReason;
      return x;
    });
  }
}

@Controller('api/v1/moderation')
@RequirePerm('moderation.work')
export class ModerationController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  @Get('reasons')
  reasons() {
    return Object.entries(REJECT_REASONS).map(([value, label]) => ({ value, label }));
  }

  @Get('counts')
  async counts() {
    const r = await one<{ pending: number; today: number }>(
      this.ctx.pool,
      `SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
              count(*) FILTER (WHERE moderated_at > date_trunc('day', now()))::int AS today
         FROM news_comment WHERE NOT is_official`,
    );
    return r;
  }

  /** Комментарии со статусом (по умолчанию — ждут решения) и ветка каждого: родитель и опубликованные ответы. */
  @Get('comments')
  async list(@Query('status') status?: string, @Query('q') q?: string) {
    const st = status === 'approved' || status === 'rejected' ? status : 'pending';
    const list = await rows(
      this.ctx.pool,
      `SELECT ${COLS},
              (SELECT row_to_json(x) FROM (SELECT p.author_name, p.body, p.is_official FROM news_comment p
                WHERE p.id = c.parent_id) x) AS parent,
              COALESCE((SELECT json_agg(json_build_object('id', r.id, 'body', r.body, 'authorName', r.author_name,
                         'isOfficial', r.is_official, 'status', r.status, 'postedAt', r.posted_at) ORDER BY r.posted_at)
                  FROM news_comment r WHERE r.parent_id = c.id), '[]') AS replies
         FROM news_comment c LEFT JOIN app_user u ON u.id = c.moderated_by
        WHERE c.status = $1 AND NOT c.is_official
          AND ($2::text IS NULL OR c.body ILIKE $2 OR c.news_title ILIKE $2 OR c.author_name ILIKE $2)
        ORDER BY ${st === 'pending' ? 'c.received_at' : 'c.moderated_at DESC'} LIMIT 300`,
      [st, q?.trim() ? `%${q.trim()}%` : null],
    );
    return list.map((r) => toApi(r));
  }

  private async decide(p: Principal, id: string, status: 'approved' | 'rejected', reason: string | null) {
    parse(z.string().uuid(), id);
    return withTx(this.ctx.pool, async (tx) => {
      const before = await one<{ status: string }>(
        tx,
        `SELECT status FROM news_comment WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!before) throw notFound('Комментарий');
      if (before.status !== 'pending')
        throw new ApiError(409, 'moderated', 'Этот комментарий уже промодерирован — обновите список');
      await tx.query(
        `UPDATE news_comment SET status = $2, reject_reason = $3, moderated_by = $4, moderated_at = now() WHERE id = $1`,
        [id, status, reason, p.id],
      );
      await emitModerated(tx, id, status === 'approved' ? 'approved' : 'rejected');
      await audit(
        tx,
        p,
        status === 'approved' ? 'approve' : 'reject',
        'news_comment',
        id,
        before,
        { status, reason },
        {
          configChanged: false,
        },
      );
      return { ok: true };
    });
  }

  @Post('comments/:id/approve')
  @HttpCode(200)
  approve(@CurrentUser() p: Principal, @Param('id') id: string) {
    return this.decide(p, id, 'approved', null);
  }

  @Post('comments/:id/reject')
  @HttpCode(200)
  reject(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(Reject, body);
    return this.decide(p, id, 'rejected', b.note ? `${b.reason}: ${b.note}` : b.reason);
  }

  /** Ответ компании под комментарием: публикуется сразу (вместе с комментарием, если он ещё ждал решения). */
  @Post('comments/:id/reply')
  @HttpCode(200)
  async reply(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    parse(z.string().uuid(), id);
    const b = parse(Reply, body);
    return withTx(this.ctx.pool, async (tx) => {
      const c = await one<{
        status: string;
        news_id: string;
        news_title: string;
        news_url: string | null;
        source: string;
      }>(
        tx,
        `SELECT status, news_id, news_title, news_url, source FROM news_comment WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!c) throw notFound('Комментарий');
      if (c.status === 'rejected')
        throw new ApiError(409, 'rejected', 'Комментарий отклонён — ответ не публикуется');
      if (c.status === 'pending' && b.approve) {
        await tx.query(
          `UPDATE news_comment SET status = 'approved', moderated_by = $2, moderated_at = now() WHERE id = $1`,
          [id, p.id],
        );
        await emitModerated(tx, id, 'approved');
      }
      const rid = newId();
      await tx.query(
        `INSERT INTO news_comment (id, source, news_id, news_title, news_url, parent_id, author_name, is_official, body,
                                   status, moderated_by, moderated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'Белоруснефть', true, $7, 'approved', $8, now())`,
        [rid, c.source, c.news_id, c.news_title, c.news_url, id, b.text, p.id],
      );
      await emitModerated(tx, rid, 'reply');
      await audit(tx, p, 'reply', 'news_comment', id, null, { replyId: rid }, { configChanged: false });
      return { ok: true, replyId: rid };
    });
  }
}
