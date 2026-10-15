import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { Principal } from '@cc/auth';
import { newId } from '@cc/contracts';
import type { FastifyRequest } from 'fastify';
import { appendFile, mkdir, open, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { CurrentUser, RequirePerm } from '../auth/guard';
import { APP_CONTEXT, type AppContext } from '../context';
import { audit } from '../lib/audit';
import { one, rows, toApi, withTx } from '../lib/db';
import { ApiError, badRequest, notFound, parse } from '../lib/errors';

/**
 * Описание обновления (manifest.json в файле обновления, Д-065). Готовит его ops/make-update.sh на стенде;
 * интерфейс показывает его перед установкой: что меняется, какие блоки затронуты и на сколько останавливаются,
 * прерывается ли приём обращений, предупреждения.
 */
export const ManifestSchema = z.object({
  format: z.literal('cc-update/1'),
  version: z.string().min(1).max(100),
  title: z.string().max(300).default(''),
  createdAt: z.string().max(40).optional(),
  /** С каких версий можно ставить (пусто — с любой). */
  fromVersions: z.array(z.string().max(100)).max(50).default([]),
  /** Прерывается ли приём обращений и примерно на сколько минут. */
  stopsIntake: z.boolean().default(false),
  intakeStopMinutes: z.number().min(0).max(1440).default(0),
  durationMinutes: z.number().min(0).max(1440).default(0),
  changes: z
    .array(
      z.object({
        id: z.string().max(40).default(''),
        title: z.string().max(1000),
        important: z.boolean().default(false),
      }),
    )
    .max(500)
    .default([]),
  blocks: z
    .array(
      z.object({
        name: z.string().max(100),
        title: z.string().max(200),
        /** none — не меняется; rolling — поэтапная замена без простоя; restart — перезапуск с короткой паузой; stop — остановка. */
        effect: z.enum(['none', 'rolling', 'restart', 'stop']),
        downtimeSeconds: z.number().min(0).max(86400).default(0),
        stopsIntake: z.boolean().default(false),
        note: z.string().max(1000).default(''),
      }),
    )
    .max(100)
    .default([]),
  migrations: z.array(z.string().max(200)).max(500).default([]),
  warnings: z
    .array(z.object({ level: z.enum(['info', 'warning', 'critical']), text: z.string().max(2000) }))
    .max(100)
    .default([]),
  release: z
    .object({
      services: z.array(z.string().max(100)).max(50).default([]),
      startServices: z.array(z.string().max(100)).max(50).default([]),
      featureFlags: z.array(z.string().max(100)).max(50).default([]),
      mediaTag: z.string().max(100).optional(),
    })
    .default({}),
  images: z
    .object({ file: z.string().max(200), sha256: z.string().length(64), size: z.number() })
    .nullable()
    .default(null),
  deploy: z
    .object({ file: z.string().max(200), sha256: z.string().length(64), size: z.number() })
    .nullable()
    .default(null),
});
export type Manifest = z.infer<typeof ManifestSchema>;

const MAX_SIZE = 20 * 1024 ** 3;
const StartBody = z
  .object({ fileName: z.string().trim().min(1).max(200), size: z.number().int().min(1).max(MAX_SIZE) })
  .strict();
const ConfirmBody = z.object({ confirmed: z.literal(true) }).strict();

/** Файлы внутри tar (формат ustar): имя → смещение и размер содержимого. Читаются только заголовки. */
async function tarEntries(path: string): Promise<Map<string, { offset: number; size: number }>> {
  const fh = await open(path, 'r');
  try {
    const total = (await fh.stat()).size;
    const out = new Map<string, { offset: number; size: number }>();
    const head = Buffer.alloc(512);
    let pos = 0;
    while (pos + 512 <= total) {
      await fh.read(head, 0, 512, pos);
      if (head.every((b) => b === 0)) break;
      const str = (a: number, n: number) =>
        head
          .subarray(a, a + n)
          .toString('utf8')
          .replace(/\0.*$/s, '');
      // Префикс имени — только в формате POSIX ustar (у GNU tar на этом месте другие поля).
      const prefix = head.subarray(257, 263).toString('latin1') === 'ustar\0' ? str(345, 155) : '';
      const name = (prefix ? `${prefix}/` : '') + str(0, 100);
      const size = parseInt(str(124, 12).trim() || '0', 8);
      if (!Number.isFinite(size)) throw new Error('bad tar');
      out.set(name.replace(/^\.\//, ''), { offset: pos + 512, size });
      pos += 512 + Math.ceil(size / 512) * 512;
    }
    return out;
  } finally {
    await fh.close();
  }
}

/** Проверка загруженного файла: tar с manifest.json и файлами, на которые он ссылается. */
async function readPackage(path: string): Promise<Manifest> {
  let entries;
  try {
    entries = await tarEntries(path);
  } catch {
    throw new Error('Это не файл обновления (ожидается .ccupd, подготовленный ops/make-update.sh)');
  }
  const m = entries.get('manifest.json');
  if (!m || m.size > 2 * 1024 * 1024) throw new Error('В файле нет описания обновления (manifest.json)');
  const fh = await open(path, 'r');
  const buf = Buffer.alloc(m.size);
  try {
    await fh.read(buf, 0, m.size, m.offset);
  } finally {
    await fh.close();
  }
  let json: unknown;
  try {
    json = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new Error('Описание обновления повреждено (manifest.json не читается)');
  }
  const r = ManifestSchema.safeParse(json);
  if (!r.success) throw new Error(`Описание обновления не того формата: ${r.error.issues[0]?.message ?? ''}`);
  for (const part of [r.data.images, r.data.deploy])
    if (part && entries.get(part.file)?.size !== part.size)
      throw new Error(`В файле нет ${part.file} или он неполный — файл повреждён`);
  return r.data;
}

/**
 * Обновление системы из файла (Д-065): загрузка частями, проверка и показ описания, подтверждение, ход и журнал.
 * Выполняет обновление служба updater (ops/updater) — у API нет доступа к Docker. Право «Обновление системы».
 * Маршрут /api/v1/system-update обслуживает экземпляр api-reports (у него том /updates).
 */
@Controller('api/v1/system-update')
@RequirePerm('system.update')
export class SystemUpdateController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  private file(id: string) {
    return join(this.ctx.config.UPDATES_DIR, `${id}.ccupd`);
  }

  /** Текущая версия, готовность службы обновления, последние обновления. */
  @Get()
  async state() {
    const u = await one<{ seen_at: Date; info: Record<string, unknown>; alive: boolean }>(
      this.ctx.pool,
      `SELECT seen_at, info, seen_at > now() - interval '30 seconds' AS alive FROM system_updater WHERE id = 1`,
    );
    const list = await rows(
      this.ctx.pool,
      `SELECT s.id, s.file_name, s.size_bytes, s.received_bytes, s.status, s.manifest ->> 'version' AS version,
              s.manifest ->> 'title' AS title, s.from_version, s.created_at, s.started_at, s.finished_at, s.step, s.error,
              u.full_name AS uploaded_by_name, c.full_name AS confirmed_by_name
         FROM system_update s LEFT JOIN app_user u ON u.id = s.uploaded_by LEFT JOIN app_user c ON c.id = s.confirmed_by
        WHERE s.status <> 'cancelled' ORDER BY s.created_at DESC LIMIT 20`,
    );
    return {
      version: this.ctx.config.APP_VERSION,
      updater: u ? { alive: u.alive, seenAt: u.seen_at, dryRun: !!u.info.dryRun } : null,
      items: list.map((r) => toApi(r)),
    };
  }

  /** Начать загрузку файла: дальше — части по порядку (PUT …/chunk?offset=…). */
  @Post()
  async create(@CurrentUser() p: Principal, @Body() body: unknown) {
    const b = parse(StartBody, body);
    if (!/\.ccupd$/i.test(b.fileName)) throw badRequest('Нужен файл обновления .ccupd');
    const id = newId();
    await mkdir(this.ctx.config.UPDATES_DIR, { recursive: true });
    await writeFile(this.file(id), Buffer.alloc(0));
    await this.ctx.pool.query(
      `INSERT INTO system_update (id, file_name, size_bytes, uploaded_by, from_version) VALUES ($1, $2, $3, $4, $5)`,
      [id, b.fileName, b.size, p.id, this.ctx.config.APP_VERSION],
    );
    return { id };
  }

  @Put(':id/chunk')
  async chunk(@Param('id') id: string, @Query('offset') offsetQ: string, @Req() req: FastifyRequest) {
    const u = await this.load(id);
    if (u.status !== 'uploading') throw new ApiError(409, 'bad_status', 'Файл уже загружен');
    const data = req.body;
    if (!Buffer.isBuffer(data) || !data.length) throw badRequest('Пустая часть файла');
    const offset = Number(offsetQ);
    const have = (await stat(this.file(id))).size;
    // Повтор уже записанной части (обрыв связи после записи) — не ошибка.
    if (offset + data.length <= have) return { received: have };
    if (offset !== have)
      throw new ApiError(409, 'bad_offset', `Ожидается часть с ${have}`, { expected: have });
    if (have + data.length > Number(u.size_bytes)) throw badRequest('Файл больше заявленного размера');
    await appendFile(this.file(id), data);
    const received = have + data.length;
    await this.ctx.pool.query('UPDATE system_update SET received_bytes = $2 WHERE id = $1', [id, received]);
    if (received === Number(u.size_bytes)) {
      try {
        const manifest = await readPackage(this.file(id));
        await this.ctx.pool.query(`UPDATE system_update SET status = 'ready', manifest = $2 WHERE id = $1`, [
          id,
          JSON.stringify(manifest),
        ]);
      } catch (e) {
        await this.ctx.pool.query(`UPDATE system_update SET status = 'invalid', error = $2 WHERE id = $1`, [
          id,
          e instanceof Error ? e.message : String(e),
        ]);
        await rm(this.file(id), { force: true });
      }
    }
    return { received };
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const u = await this.load(id);
    return {
      ...toApi(u),
      currentVersion: this.ctx.config.APP_VERSION,
      compatible:
        !u.manifest?.fromVersions?.length || u.manifest.fromVersions.includes(this.ctx.config.APP_VERSION),
    };
  }

  /** Подтвердить и поставить в очередь службы обновления. */
  @Post(':id/start')
  @HttpCode(200)
  async start(@CurrentUser() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    parse(ConfirmBody, body);
    const u = await this.load(id);
    if (u.status !== 'ready')
      throw new ApiError(409, 'bad_status', 'Файл ещё не загружен или уже установлен');
    const alive = await one<{ ok: boolean }>(
      this.ctx.pool,
      `SELECT seen_at > now() - interval '30 seconds' AS ok FROM system_updater WHERE id = 1`,
    );
    if (!alive?.ok)
      throw new ApiError(
        409,
        'updater_down',
        'Служба обновления не отвечает — обновление сейчас не начнётся',
      );
    await withTx(this.ctx.pool, async (tx) => {
      const r = await tx.query(
        `UPDATE system_update SET status = 'queued', confirmed_by = $2, confirmed_at = now(), step = 'Ожидает службу обновления'
          WHERE id = $1 AND status = 'ready'
            AND NOT EXISTS (SELECT 1 FROM system_update WHERE status IN ('queued', 'running'))`,
        [id, p.id],
      );
      if (!r.rowCount) throw new ApiError(409, 'busy', 'Уже идёт другое обновление');
      await audit(tx, p, 'update', 'system_update', id, null, {
        version: u.manifest?.version,
        from: this.ctx.config.APP_VERSION,
      });
    });
    return this.get(id);
  }

  /** Отменить до начала (загрузка, проверено, в очереди) — файл удаляется. */
  @Post(':id/cancel')
  @HttpCode(200)
  async cancel(@CurrentUser() p: Principal, @Param('id') id: string) {
    const r = await this.ctx.pool.query(
      `UPDATE system_update SET status = 'cancelled' WHERE id = $1 AND status IN ('uploading', 'ready', 'invalid', 'queued')`,
      [parse(z.string().uuid(), id)],
    );
    if (!r.rowCount) throw new ApiError(409, 'bad_status', 'Обновление уже выполняется или завершено');
    await rm(this.file(id), { force: true });
    await withTx(this.ctx.pool, (tx) => audit(tx, p, 'delete', 'system_update', id, null, null));
    return { cancelled: 1 };
  }

  private async load(id: string) {
    const u = await one<{
      id: string;
      status: string;
      size_bytes: string;
      manifest: Manifest | null;
    }>(this.ctx.pool, 'SELECT * FROM system_update WHERE id = $1', [parse(z.string().uuid(), id)]);
    if (!u) throw notFound('Обновление');
    return u;
  }
}
