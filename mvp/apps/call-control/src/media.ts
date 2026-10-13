import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '@cc/service-kit';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { RecordingStore } from './recordings';

const MAX_CACHE_BYTES = 64 * 1024 * 1024;

/**
 * Раздача аудиофайлов библиотеки IVR узлам Asterisk: `GET /media/<id>/<версия>.wav`. Asterisk забирает файл по
 * HTTP (res_http_media_cache) и кэширует у себя по URI — в том числе между перезапусками. Запись библиотеки
 * может получить новое содержимое под тем же id (замена голоса, `Озвучка/apply_voice.py`), поэтому в URI —
 * версия по `storage_key`: новое содержимое — новый URI, старый кэш Asterisk не используется (Д-025).
 * Старый вид `/media/<id>.wav` тоже отдаётся.
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
    const m = /^\/media\/([0-9a-f-]{36})(?:\/([0-9a-f]{1,32}))?\.wav$/i.exec(
      (req.url ?? '').split('?')[0] ?? '',
    );
    if (!m || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
    const id = m[1]!.toLowerCase();
    try {
      const { rows } = await this.pool.query<{ storage_key: string }>(
        `SELECT storage_key FROM audio_file WHERE id = $1`,
        [id],
      );
      if (!rows[0]) {
        res.writeHead(404).end();
        return true;
      }
      const key = rows[0].storage_key;
      let body = this.cache.get(key);
      if (!body) {
        body = await this.store.object(key);
        this.remember(key, body);
      }
      res.writeHead(200, {
        'content-type': 'audio/wav',
        'content-length': body.length,
        'cache-control': 'public, max-age=86400, immutable',
        etag: `"${mediaVersion(key)}"`,
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

/** Версия содержимого записи библиотеки — часть URI для Asterisk (меняется при замене файла). */
export function mediaVersion(storageKey: string): string {
  return createHash('sha1').update(storageKey).digest('hex').slice(0, 12);
}

/** URI записей библиотеки для проигрывания в Asterisk (`sound:` с версией содержимого), порядок сохраняется. */
export async function mediaUris(pool: Pool, baseUrl: string, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const { rows } = await pool.query<{ id: string; storage_key: string }>(
    `SELECT id, storage_key FROM audio_file WHERE id = ANY ($1::uuid[])`,
    [ids],
  );
  const ver = new Map(rows.map((r) => [r.id, mediaVersion(r.storage_key)]));
  return ids.map((id) => {
    const v = ver.get(id);
    return v ? `sound:${baseUrl}/media/${id}/${v}.wav` : `sound:${baseUrl}/media/${id}.wav`;
  });
}
