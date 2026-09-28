import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { newId } from '@cc/contracts';
import type { Pool } from 'pg';

export interface AttachmentRef {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

/** Опасные расширения не принимаются ни из одного канала (как и в веб-чате). */
const BLOCKED = /\.(exe|bat|cmd|com|scr|js|vbs|msi|ps1|sh)$/i;

export class ConnectorStorage {
  private readonly s3: S3Client;

  constructor(
    private readonly o: {
      endpoint: string;
      bucket: string;
      accessKey: string;
      secretKey: string;
      pool: Pool;
    },
  ) {
    this.s3 = new S3Client({
      endpoint: o.endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: o.accessKey, secretAccessKey: o.secretKey },
    });
  }

  /**
   * Вложение входящего сообщения: файл — в S3-хранилище, запись — в `attachment` (ещё не привязана к
   * обращению; привязку делает worker при сохранении сообщения). null — файл отклонён.
   */
  async saveInbound(file: {
    filename: string;
    contentType: string;
    body: Buffer;
  }): Promise<AttachmentRef | null> {
    const filename = file.filename.slice(0, 200).replace(/[\\/]/g, '_') || 'file';
    if (BLOCKED.test(filename)) return null;
    const id = newId();
    const key = `attachments/${new Date().toISOString().slice(0, 7)}/${id}`;
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.o.bucket,
        Key: key,
        Body: file.body,
        ContentType: file.contentType,
      }),
    );
    await this.o.pool.query(
      `INSERT INTO attachment (id, filename, content_type, size_bytes, storage_key) VALUES ($1, $2, $3, $4, $5)`,
      [id, filename, file.contentType, file.body.length, key],
    );
    return { id, filename, contentType: file.contentType, size: file.body.length };
  }

  /** Содержимое вложения исходящего сообщения (по id записи `attachment`). */
  async read(id: string): Promise<{ filename: string; contentType: string; body: Buffer }> {
    const { rows } = await this.o.pool.query<{ storage_key: string; filename: string; content_type: string }>(
      'SELECT storage_key, filename, content_type FROM attachment WHERE id = $1',
      [id],
    );
    if (!rows[0]) throw new Error(`вложение ${id} не найдено`);
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.o.bucket, Key: rows[0].storage_key }));
    const body = Buffer.from(await r.Body!.transformToByteArray());
    return { filename: rows[0].filename, contentType: rows[0].content_type, body };
  }
}
