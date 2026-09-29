import { Controller, Get, HttpCode, Inject, Post, Query, Req, Res } from '@nestjs/common';
import type { Principal } from '@cc/auth';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CurrentUser, RequirePerm } from '../auth/guard';
import { APP_CONTEXT, type AppContext } from '../context';
import { audit } from '../lib/audit';
import { badRequest } from '../lib/errors';
import { exportConfig, importConfig } from './config-transfer';

/** Экспорт/импорт конфигурации (Ф9, M-ADM-05): «Администрирование → Экспорт и импорт». */
@Controller('api/v1/config')
@RequirePerm('admin.settings')
export class ConfigController {
  constructor(@Inject(APP_CONTEXT) private readonly ctx: AppContext) {}

  @Get('export')
  async export(
    @CurrentUser() p: Principal,
    @Query('audio') audio: string | undefined,
    @Res() reply: FastifyReply,
  ) {
    const doc = await exportConfig(this.ctx.pool, this.ctx.storage, { includeAudio: audio !== 'false' });
    const client = await this.ctx.pool.connect();
    try {
      await audit(client, p, 'export', 'config', null, null, null, { configChanged: false });
    } finally {
      client.release();
    }
    const stamp = doc.exportedAt.slice(0, 16).replace(/[:T]/g, '-');
    reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="cc-config-${stamp}.json"`);
    return reply.send(JSON.stringify(doc, null, 1));
  }

  /**
   * Импорт: тело — файл экспорта (application/json до 1 МБ или application/octet-stream до MAX_UPLOAD_MB).
   * ?dryRun=true — проверка и отчёт без изменений. Всё в одной транзакции; config.changed — сервисы
   * применяют настройки без перезапуска.
   */
  @Post('import')
  @HttpCode(200)
  async import(@CurrentUser() p: Principal, @Req() req: FastifyRequest, @Query('dryRun') dryRun?: string) {
    let doc: unknown = req.body;
    if (Buffer.isBuffer(doc)) {
      try {
        doc = JSON.parse(doc.toString('utf8'));
      } catch {
        throw badRequest('Файл не в формате JSON');
      }
    }
    const dry = dryRun === 'true';
    const tx = await this.ctx.pool.connect();
    try {
      await tx.query('BEGIN');
      const report = await importConfig(tx, this.ctx.storage, doc, { actorId: p.id, dryRun: dry });
      if (dry) {
        await tx.query('ROLLBACK');
      } else {
        await audit(tx, p, 'import', 'config', null, null, {
          sections: report.sections.filter((s) => s.created || s.updated),
          warnings: report.warnings,
        });
        await tx.query('COMMIT');
        this.ctx.principals.invalidate();
      }
      return report;
    } catch (e) {
      await tx.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      tx.release();
    }
  }
}
