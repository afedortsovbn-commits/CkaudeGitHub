import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { newId } from '@cc/contracts';
import {
  collectRefs,
  type FlowGraph,
  NUMBER_FRAGMENTS,
  parseGraph,
  validateGraph,
  type ValidationResult,
} from '@cc/flow-engine';
import type { Principal } from '@cc/auth';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CurrentUser, RequirePerm } from '../auth/guard';
import { APP_CONTEXT, type AppContext } from '../context';
import { audit } from '../lib/audit';
import { type Db, one, rows, toApi, withTx } from '../lib/db';
import { ApiError, badRequest, notFound, parse } from '../lib/errors';
import { executeOperation } from './integrations';
import { parseWav } from './wav';

const FlowCreate = z
  .object({
    name: z.string().trim().min(1).max(200),
    kind: z.enum(['voice', 'text']).default('voice'),
    description: z.string().trim().max(2000).nullable().optional(),
    dids: z.array(z.string().trim().min(1).max(32)).max(50).default([]),
  })
  .strict();
const FlowPatch = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    dids: z.array(z.string().trim().min(1).max(32)).max(50).optional(),
    draft: z.unknown().optional(),
  })
  .strict();
const Publish = z.object({ comment: z.string().trim().max(500).optional() }).strict();
const Rollback = z.object({ versionId: z.string().uuid() }).strict();
const AudioPatch = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    fragmentKey: z.string().trim().max(32).nullable().optional(),
  })
  .strict();
const TestRun = z.object({ input: z.record(z.string().max(2000)).default({}) }).strict();

const MAX_AUDIO_MB = 10;

function emptyGraph(kind: 'voice' | 'text'): FlowGraph {
  return {
    version: 1,
    kind,
    nodes: [{ id: 'start', type: 'start', position: { x: 40, y: 40 }, params: {} }],
    edges: [],
  };
}

/**
 * Конструктор IVR (M-IVR-01/04/06/07), аудиобиблиотека, интеграционные операции (M-INT-03) и панель
 * внешних данных клиента (M-CARD-07). Сценарий: черновик → проверка → публикация (новая неизменяемая
 * версия, атомарное переключение `published_version_id`) → откат на любую прежнюю версию. Идущие вызовы
 * доигрывают свою версию: call-control запоминает её при входе вызова.
 */
@Controller('api/v1')
export class IvrController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  // ------------------------------------------------------------------ сценарии

  @Get('flows')
  @RequirePerm('admin.directories', 'supervisor.monitor')
  async flows(@Query('kind') kind?: string) {
    const list = await rows(
      this.ctx.pool,
      `SELECT f.id, f.name, f.kind, f.description, f.dids, f.is_active, f.draft_updated_at, f.published_version_id,
              v.version AS published_version, v.created_at AS published_at,
              (f.draft_updated_at > COALESCE(v.created_at, 'epoch')) AS has_unpublished
         FROM flow f LEFT JOIN flow_version v ON v.id = f.published_version_id
        WHERE ($1::text IS NULL OR f.kind = $1) ORDER BY f.name`,
      [kind ?? null],
    );
    return list.map((r) => toApi(r));
  }

  @Post('flows')
  @RequirePerm('admin.directories')
  async createFlow(@CurrentUser() p: Principal, @Body() body: unknown) {
    const b = parse(FlowCreate, body);
    const id = newId();
    return withTx(this.ctx.pool, async (tx) => {
      await this.checkDids(tx, id, b.kind, b.dids);
      const row = await one(
        tx,
        `INSERT INTO flow (id, name, kind, description, dids, draft, draft_updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [id, b.name, b.kind, b.description ?? null, b.dids, JSON.stringify(emptyGraph(b.kind)), p.id],
      );
      await audit(tx, p, 'create', 'flow', id, null, { name: b.name, kind: b.kind, dids: b.dids });
      return toApi(row!);
    });
  }

  @Get('flows/:id')
  @RequirePerm('admin.directories', 'supervisor.monitor')
  async flow(@Param('id') id: string) {
    const f = await one(
      this.ctx.pool,
      `SELECT f.*, v.version AS published_version FROM flow f
         LEFT JOIN flow_version v ON v.id = f.published_version_id WHERE f.id = $1`,
      [id],
    );
    if (!f) throw notFound('Сценарий');
    const versions = await rows(
      this.ctx.pool,
      `SELECT v.id, v.version, v.comment, v.created_at, u.full_name AS created_by_name
         FROM flow_version v LEFT JOIN app_user u ON u.id = v.created_by
        WHERE v.flow_id = $1 ORDER BY v.version DESC`,
      [id],
    );
    return { ...toApi(f), versions: versions.map((r) => toApi(r)) };
  }

  @Patch('flows/:id')
  @RequirePerm('admin.directories')
  async patchFlow(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(FlowPatch, body);
    return withTx(this.ctx.pool, async (tx) => {
      const before = await one<{ kind: 'voice' | 'text'; name: string; dids: string[] }>(
        tx,
        `SELECT kind, name, dids FROM flow WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!before) throw notFound('Сценарий');
      let draft: FlowGraph | null = null;
      if (b.draft !== undefined) {
        const g = parseGraph(b.draft);
        if (typeof g === 'string') throw badRequest(g);
        if (g.kind !== before.kind) throw badRequest('Тип сценария изменить нельзя');
        draft = g;
      }
      if (b.dids) await this.checkDids(tx, id, before.kind, b.dids);
      const row = await one(
        tx,
        `UPDATE flow SET name = COALESCE($2, name),
           description = CASE WHEN $3::boolean THEN $4 ELSE description END,
           dids = COALESCE($5, dids),
           draft = COALESCE($6, draft),
           draft_updated_at = CASE WHEN $6::jsonb IS NULL THEN draft_updated_at ELSE now() END,
           draft_updated_by = CASE WHEN $6::jsonb IS NULL THEN draft_updated_by ELSE $7 END,
           updated_at = now()
         WHERE id = $1 RETURNING *`,
        [
          id,
          b.name ?? null,
          b.description !== undefined,
          b.description ?? null,
          b.dids ?? null,
          draft ? JSON.stringify(draft) : null,
          p.id,
        ],
      );
      // Черновик на работу не влияет — в аудит пишем только свойства сценария (номера — влияют сразу).
      if (b.name || b.dids || b.description !== undefined)
        await audit(
          tx,
          p,
          'update',
          'flow',
          id,
          { name: before.name, dids: before.dids },
          { name: row!.name, dids: row!.dids },
        );
      return toApi(row!);
    });
  }

  @Post('flows/:id/validate')
  @HttpCode(200)
  @RequirePerm('admin.directories')
  async validate(@Param('id') id: string) {
    const f = await one<{ draft: unknown; kind: 'voice' | 'text' }>(
      this.ctx.pool,
      `SELECT draft, kind FROM flow WHERE id = $1`,
      [id],
    );
    if (!f) throw notFound('Сценарий');
    return this.check(this.ctx.pool, f.draft, f.kind);
  }

  @Post('flows/:id/publish')
  @HttpCode(200)
  @RequirePerm('admin.directories')
  async publish(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(Publish, body ?? {});
    return withTx(this.ctx.pool, async (tx) => {
      const f = await one<{ draft: unknown; kind: 'voice' | 'text'; published_version_id: string | null }>(
        tx,
        `SELECT draft, kind, published_version_id FROM flow WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!f) throw notFound('Сценарий');
      const res = await this.check(tx, f.draft, f.kind);
      if (res.errors.length) throw new ApiError(400, 'invalid_flow', 'Сценарий содержит ошибки', res);
      const v = await one<{ n: number }>(
        tx,
        `SELECT COALESCE(max(version), 0) + 1 AS n FROM flow_version WHERE flow_id = $1`,
        [id],
      );
      const versionId = newId();
      await tx.query(
        `INSERT INTO flow_version (id, flow_id, version, graph, comment, created_by) VALUES ($1, $2, $3, $4, $5, $6)`,
        [versionId, id, v!.n, JSON.stringify(f.draft), b.comment ?? null, p.id],
      );
      await tx.query(`UPDATE flow SET published_version_id = $2, updated_at = now() WHERE id = $1`, [
        id,
        versionId,
      ]);
      await audit(
        tx,
        p,
        'publish',
        'flow',
        id,
        { versionId: f.published_version_id },
        { versionId, version: v!.n },
      );
      return { versionId, version: v!.n, warnings: res.warnings };
    });
  }

  /** Откат (M-IVR-06): опубликованной становится выбранная прежняя версия. */
  @Post('flows/:id/rollback')
  @HttpCode(200)
  @RequirePerm('admin.directories')
  async rollback(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(Rollback, body);
    return withTx(this.ctx.pool, async (tx) => {
      const f = await one<{ published_version_id: string | null }>(
        tx,
        `SELECT published_version_id FROM flow WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!f) throw notFound('Сценарий');
      const v = await one<{ version: number }>(
        tx,
        `SELECT version FROM flow_version WHERE id = $1 AND flow_id = $2`,
        [b.versionId, id],
      );
      if (!v) throw notFound('Версия');
      await tx.query(`UPDATE flow SET published_version_id = $2, updated_at = now() WHERE id = $1`, [
        id,
        b.versionId,
      ]);
      await audit(
        tx,
        p,
        'rollback',
        'flow',
        id,
        { versionId: f.published_version_id },
        { versionId: b.versionId },
      );
      return { versionId: b.versionId, version: v.version };
    });
  }

  @Get('flows/:id/versions/:versionId')
  @RequirePerm('admin.directories', 'supervisor.monitor')
  async version(@Param('id') id: string, @Param('versionId') versionId: string) {
    const v = await one(
      this.ctx.pool,
      `SELECT id, version, graph, comment, created_at FROM flow_version WHERE id = $1 AND flow_id = $2`,
      [versionId, id],
    );
    if (!v) throw notFound('Версия');
    return toApi(v);
  }

  @Post('flows/:id/:op')
  @HttpCode(200)
  @RequirePerm('admin.directories')
  async toggleFlow(@CurrentUser() p: Principal, @Param('id') id: string, @Param('op') op: string) {
    if (op !== 'activate' && op !== 'deactivate') throw notFound('Действие');
    return withTx(this.ctx.pool, async (tx) => {
      const f = await one<{ kind: 'voice' | 'text'; dids: string[] }>(
        tx,
        `SELECT kind, dids FROM flow WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!f) throw notFound('Сценарий');
      if (op === 'activate') await this.checkDids(tx, id, f.kind, f.dids);
      await tx.query(`UPDATE flow SET is_active = $2, updated_at = now() WHERE id = $1`, [
        id,
        op === 'activate',
      ]);
      await audit(tx, p, op, 'flow', id, null, null);
      return { ok: true };
    });
  }

  /** Номер обслуживает не больше одного активного голосового сценария. */
  private async checkDids(tx: Db, id: string, kind: string, dids: string[]) {
    if (kind !== 'voice' || !dids.length) return;
    const clash = await one<{ name: string; did: string }>(
      tx,
      `SELECT f.name, d AS did FROM flow f, unnest(f.dids) d
        WHERE f.id <> $1 AND f.is_active AND f.kind = 'voice' AND d = ANY ($2) LIMIT 1`,
      [id, dids],
    );
    if (clash)
      throw new ApiError(409, 'did_taken', `Номер ${clash.did} уже назначен сценарию «${clash.name}»`);
  }

  /** Проверка графа и ссылок на справочники (файлы, очереди, темы, расписания, операции). */
  private async check(db: Db, draft: unknown, kind: 'voice' | 'text'): Promise<ValidationResult> {
    const g = parseGraph(draft);
    if (typeof g === 'string') return { errors: [{ message: g }], warnings: [] };
    const res = validateGraph(g, kind);
    const refs = collectRefs(g);
    const missing = async (table: string, ids: string[], what: string) => {
      const valid = ids.filter((x) => /^[0-9a-f-]{36}$/i.test(x));
      const found = valid.length
        ? await rows<{ id: string }>(db, `SELECT id FROM ${table} WHERE id = ANY ($1) AND is_active`, [valid])
        : [];
      const ok = new Set(found.map((r) => r.id));
      for (const x of ids)
        if (!ok.has(x)) res.errors.push({ message: `${what} не найден(а) или отключен(а)` });
    };
    await missing('audio_file', refs.audio, 'Аудиофайл');
    await missing('queue', refs.queues, 'Очередь');
    await missing('topic', refs.topics, 'Тема');
    await missing('schedule', refs.schedules, 'Расписание');
    await missing('integration_op', refs.operations, 'Интеграционная операция');
    if (g.nodes.some((n) => n.type === 'sayNumber')) {
      const have = await rows<{ fragment_key: string }>(
        db,
        `SELECT fragment_key FROM audio_file WHERE kind = 'fragment' AND is_active`,
      );
      const set = new Set(have.map((r) => r.fragment_key));
      const absent = NUMBER_FRAGMENTS.filter((f) => !set.has(f.key)).map((f) => f.label);
      if (absent.length)
        res.warnings.push({
          message: `Для озвучивания чисел не загружены фрагменты: ${absent.slice(0, 8).join(', ')}${absent.length > 8 ? '…' : ''}`,
        });
    }
    return res;
  }

  // ------------------------------------------------------------------ аудиобиблиотека

  @Get('ivr/audio')
  @RequirePerm('admin.directories', 'supervisor.monitor')
  async audioList(@Query('active') active?: string) {
    const list = await rows(
      this.ctx.pool,
      `SELECT id, name, kind, fragment_key, size_bytes, duration_ms, is_active, created_at FROM audio_file
        WHERE ($1::boolean IS NULL OR is_active = $1) ORDER BY kind, name`,
      [active === 'all' ? null : active !== 'false'],
    );
    return list.map((r) => toApi(r));
  }

  @Get('ivr/fragments')
  @RequirePerm('admin.directories')
  async fragments() {
    const have = await rows<{ fragment_key: string; id: string }>(
      this.ctx.pool,
      `SELECT fragment_key, id FROM audio_file WHERE kind = 'fragment' AND is_active`,
    );
    const m = new Map(have.map((r) => [r.fragment_key, r.id]));
    return NUMBER_FRAGMENTS.map((f) => ({ ...f, audioId: m.get(f.key) ?? null }));
  }

  /**
   * Загрузка аудиофайла: тело — WAV PCM 16 бит, моно, 8 кГц (браузер приводит любой файл к этому формату
   * перед загрузкой, сервер проверяет заголовок). Имя — ?name=, фрагмент числа — ?kind=fragment&fragmentKey=.
   */
  @Post('ivr/audio')
  @RequirePerm('admin.directories')
  async uploadAudio(
    @CurrentUser() p: Principal,
    @Req() req: FastifyRequest,
    @Query() q: Record<string, string | undefined>,
  ) {
    const body = req.body;
    if (!Buffer.isBuffer(body) || !body.length) throw badRequest('Пустой файл');
    if (body.length > MAX_AUDIO_MB * 1024 * 1024)
      throw new ApiError(413, 'too_large', `Файл больше ${MAX_AUDIO_MB} МБ`);
    const wav = parseWav(body);
    if (typeof wav === 'string') throw badRequest(wav);
    const name = (q.name ?? decodeURIComponent(String(req.headers['x-filename'] ?? 'Файл')))
      .trim()
      .slice(0, 200);
    const kind = q.kind === 'fragment' ? 'fragment' : 'prompt';
    const fragmentKey = kind === 'fragment' ? (q.fragmentKey ?? '').trim() : null;
    if (kind === 'fragment' && !fragmentKey) throw badRequest('Укажите, какой это фрагмент числа');
    const id = newId();
    const key = `ivr-audio/${id}.wav`;
    await this.ctx.storage.put(key, body, 'audio/wav');
    return withTx(this.ctx.pool, async (tx) => {
      // Новый фрагмент с тем же ключом заменяет прежний (прежний отключается).
      if (fragmentKey)
        await tx.query(
          `UPDATE audio_file SET is_active = false, updated_at = now() WHERE kind = 'fragment' AND fragment_key = $1 AND is_active`,
          [fragmentKey],
        );
      const row = await one(
        tx,
        `INSERT INTO audio_file (id, name, kind, fragment_key, storage_key, size_bytes, duration_ms, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, name, kind, fragment_key, size_bytes, duration_ms, is_active, created_at`,
        [id, name || 'Файл', kind, fragmentKey, key, body.length, wav.durationMs, p.id],
      );
      await audit(tx, p, 'create', 'audio_file', id, null, { name, kind, fragmentKey });
      return toApi(row!);
    });
  }

  @Patch('ivr/audio/:id')
  @RequirePerm('admin.directories')
  async patchAudio(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(AudioPatch, body);
    return withTx(this.ctx.pool, async (tx) => {
      const before = await one(tx, `SELECT name, fragment_key FROM audio_file WHERE id = $1 FOR UPDATE`, [
        id,
      ]);
      if (!before) throw notFound('Аудиофайл');
      const row = await one(
        tx,
        `UPDATE audio_file SET name = COALESCE($2, name),
           fragment_key = CASE WHEN $3::boolean THEN $4 ELSE fragment_key END, updated_at = now()
         WHERE id = $1 RETURNING id, name, kind, fragment_key, size_bytes, duration_ms, is_active, created_at`,
        [id, b.name ?? null, b.fragmentKey !== undefined, b.fragmentKey ?? null],
      );
      await audit(tx, p, 'update', 'audio_file', id, before, {
        name: row!.name,
        fragment_key: row!.fragment_key,
      });
      return toApi(row!);
    });
  }

  @Post('ivr/audio/:id/:op')
  @HttpCode(200)
  @RequirePerm('admin.directories')
  async toggleAudio(@CurrentUser() p: Principal, @Param('id') id: string, @Param('op') op: string) {
    if (op !== 'activate' && op !== 'deactivate') throw notFound('Действие');
    return withTx(this.ctx.pool, async (tx) => {
      const r = await tx.query(`UPDATE audio_file SET is_active = $2, updated_at = now() WHERE id = $1`, [
        id,
        op === 'activate',
      ]);
      if (!r.rowCount) throw notFound('Аудиофайл');
      await audit(tx, p, op, 'audio_file', id, null, null);
      return { ok: true };
    });
  }

  /** Прослушивание файла в админке. */
  @Get('ivr/audio/:id/file')
  @RequirePerm('admin.directories', 'supervisor.monitor')
  async audioFile(@Param('id') id: string, @Res() reply: FastifyReply) {
    const a = await one<{ storage_key: string }>(
      this.ctx.pool,
      `SELECT storage_key FROM audio_file WHERE id = $1`,
      [id],
    );
    if (!a) throw notFound('Аудиофайл');
    const obj = await this.ctx.storage.get(a.storage_key);
    reply.header('content-type', 'audio/wav').header('x-content-type-options', 'nosniff');
    if (obj.length) reply.header('content-length', obj.length);
    return reply.send(obj.body);
  }

  // ------------------------------------------------------------------ интеграционные операции

  /** Тестовый запуск операции из админки и из тестового прогона сценария: возвращает и сам ответ системы. */
  @Post('integrations/:id/test')
  @HttpCode(200)
  @RequirePerm('admin.directories')
  async testOperation(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(TestRun, body ?? {});
    return executeOperation(
      { pool: this.ctx.pool, secretsKey: this.ctx.config.SECRETS_KEY, logger: this.ctx.logger },
      { operationId: id, input: b.input, source: 'test', userId: p.id },
    );
  }

  @Get('integrations/:id/log')
  @RequirePerm('admin.directories')
  async operationLog(@Param('id') id: string) {
    const list = await rows(
      this.ctx.pool,
      `SELECT at, source, ok, http_status, duration_ms, error, conversation_id FROM integration_log
        WHERE operation_id = $1 ORDER BY at DESC LIMIT 100`,
      [id],
    );
    return list.map((r) => toApi(r));
  }

  /**
   * Панель внешних данных клиента (M-CARD-07): операции с «показывать в карточке» выполняются с телефоном
   * клиента; сбой одной системы не мешает остальным.
   */
  @Get('contacts/:id/external-data')
  @RequirePerm('conversations.work', 'supervisor.monitor')
  async externalData(
    @CurrentUser() p: Principal,
    @Param('id') id: string,
    @Query('conversationId') conv?: string,
  ) {
    const c = await one<{ phone: string | null }>(this.ctx.pool, `SELECT phone FROM contact WHERE id = $1`, [
      id,
    ]);
    if (!c) throw notFound('Клиент');
    const ops = await rows<{
      id: string;
      name: string;
      card_input: string | null;
      outputs: { name: string; label: string }[];
    }>(
      this.ctx.pool,
      `SELECT id, name, card_input, outputs FROM integration_op WHERE show_in_card AND is_active ORDER BY name`,
    );
    return Promise.all(
      ops.map(async (op) => {
        if (!c.phone)
          return {
            operationId: op.id,
            name: op.name,
            ok: false,
            error: 'У клиента нет телефона',
            fields: [],
          };
        const r = await executeOperation(
          { pool: this.ctx.pool, secretsKey: this.ctx.config.SECRETS_KEY, logger: this.ctx.logger },
          {
            operationId: op.id,
            input: { [op.card_input || 'phone']: c.phone },
            source: 'card',
            userId: p.id,
            conversationId: conv && /^[0-9a-f-]{36}$/i.test(conv) ? conv : null,
          },
        );
        return {
          operationId: op.id,
          name: op.name,
          ok: r.ok,
          error: r.error ?? null,
          fields: op.outputs.map((o) => ({
            name: o.name,
            label: o.label || o.name,
            value: r.outputs[o.name] ?? '',
          })),
        };
      }),
    );
  }
}
