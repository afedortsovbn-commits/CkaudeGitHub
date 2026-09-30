import { newId } from '@cc/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context';
import { one } from './db';
import { ApiError, badRequest } from './errors';

export interface AttachmentMeta {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

const BLOCKED = /\.(exe|bat|cmd|com|scr|js|vbs|msi|ps1|sh)$/i;

/** Сохраняет тело запроса (raw) как вложение. Имя файла — заголовок x-filename (URI-encoded). */
export async function saveUpload(
  ctx: AppContext,
  req: FastifyRequest,
  owner: { contactId?: string; userId?: string },
  maxMb = ctx.config.MAX_UPLOAD_MB,
): Promise<AttachmentMeta> {
  const body = req.body;
  if (!Buffer.isBuffer(body) || body.length === 0) throw badRequest('Пустой файл');
  if (body.length > maxMb * 1024 * 1024) throw new ApiError(413, 'too_large', `Файл больше ${maxMb} МБ`);
  const filename = decodeURIComponent(String(req.headers['x-filename'] ?? 'file'))
    .slice(0, 200)
    .replace(/[\\/]/g, '_');
  if (BLOCKED.test(filename)) throw badRequest('Такой тип файла не допускается');
  const contentType = String(req.headers['content-type'] ?? 'application/octet-stream').split(';')[0]!;
  const id = newId();
  const key = `attachments/${new Date().toISOString().slice(0, 7)}/${id}`;
  await ctx.storage.put(key, body, contentType);
  await ctx.pool.query(
    `INSERT INTO attachment (id, contact_id, uploaded_by_user, filename, content_type, size_bytes, storage_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, owner.contactId ?? null, owner.userId ?? null, filename, contentType, body.length, key],
  );
  return { id, filename, contentType, size: body.length };
}

export async function sendAttachment(
  ctx: AppContext,
  id: string,
  reply: FastifyReply,
  access: (a: { conversation_id: string | null; contact_id: string | null }) => Promise<boolean>,
) {
  const a = await one<{
    storage_key: string;
    filename: string;
    content_type: string;
    conversation_id: string | null;
    contact_id: string | null;
    deleted_at: Date | null;
  }>(ctx.pool, 'SELECT * FROM attachment WHERE id = $1', [id]);
  if (!a || !(await access(a))) throw new ApiError(404, 'not_found', 'Файл не найден');
  if (a.deleted_at) throw new ApiError(410, 'deleted', 'Файл удалён (обезличивание клиента)');
  const obj = await ctx.storage.get(a.storage_key);
  const inline = /^(image\/|application\/pdf)/.test(a.content_type);
  reply
    .header('content-type', a.content_type)
    .header('x-content-type-options', 'nosniff')
    .header(
      'content-disposition',
      `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
    );
  return reply.send(obj.body);
}

/** Проверяет, что вложения загружены этим владельцем и ещё не привязаны к чужому обращению. */
export async function ownAttachments(
  ctx: AppContext,
  ids: string[],
  owner: { contactId?: string; userId?: string },
): Promise<AttachmentMeta[]> {
  if (!ids.length) return [];
  const { rows } = await ctx.pool.query<{
    id: string;
    filename: string;
    content_type: string;
    size_bytes: string;
  }>(
    `SELECT id, filename, content_type, size_bytes FROM attachment
      WHERE id = ANY($1) AND conversation_id IS NULL
        AND (($2::uuid IS NOT NULL AND contact_id = $2) OR ($3::uuid IS NOT NULL AND uploaded_by_user = $3))`,
    [ids, owner.contactId ?? null, owner.userId ?? null],
  );
  if (rows.length !== new Set(ids).size) throw badRequest('Вложение не найдено или уже использовано');
  return rows.map((r) => ({
    id: r.id,
    filename: r.filename,
    contentType: r.content_type,
    size: Number(r.size_bytes),
  }));
}
