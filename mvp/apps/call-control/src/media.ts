import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '@cc/service-kit';
import type { Pool } from 'pg';
import type { RecordingStore } from './recordings';

const MAX_CACHE_BYTES = 64 * 1024 * 1024;

/**
 * Раздача аудиофайлов библиотеки IVR узлам Asterisk: `GET /media/<id>.wav`. Asterisk забирает файл по
 * HTTP (res_http_media_cache, URI `sound:http://call-control:3000/media/<id>.wav`) и кэширует у себя;
 * файл по id неизменяем (новая загрузка — новый id), поэтому кэш без проверки свежести.
 */
export class MediaFiles {
  private readonly cache = new Map<string, Buffer>();
  private bytes = 0;

  constructor(
    private readonly pool: Pool,
    private readonly store: RecordingStore,
    private readonly logger: Logger,
  ) {}

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const m = /^\/media\/([0-9a-f-]{36})\.wav$/i.exec((req.url ?? '').split('?')[0] ?? '');
    if (!m || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
    const id = m[1]!.toLowerCase();
    try {
      let body = this.cache.get(id);
      if (!body) {
        const { rows } = await this.pool.query<{ storage_key: string }>(
          `SELECT storage_key FROM audio_file WHERE id = $1`,
          [id],
        );
        if (!rows[0]) {
          res.writeHead(404).end();
          return true;
        }
        body = await this.store.object(rows[0].storage_key);
        this.remember(id, body);
      }
      res.writeHead(200, {
        'content-type': 'audio/wav',
        'content-length': body.length,
        'cache-control': 'public, max-age=86400, immutable',
        etag: `"${id}"`,
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (err) {
      this.logger.warn({ err: String(err), id }, 'не удалось отдать аудиофайл IVR');
      res.writeHead(502).end();
    }
    return true;
  }

  private remember(id: string, body: Buffer): void {
    this.cache.set(id, body);
    this.bytes += body.length;
    for (const [k, v] of this.cache) {
      if (this.bytes <= MAX_CACHE_BYTES) break;
      this.cache.delete(k);
      this.bytes -= v.length;
    }
  }
}
