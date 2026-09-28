import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { CONVERSATION_EVENTS } from '@cc/contracts';
import { emitConversation, loadRef } from '@cc/domain';
import type { Logger } from '@cc/service-kit';
import type { Pool } from 'pg';
import type { Ari } from './ari';

const MAX_ATTEMPTS = 20;

/**
 * Записи разговоров (M-TEL-04): Asterisk пишет файл на диск узла, после завершения записи call-control
 * выгружает его в S3-хранилище (повторы при сбое хранилища), удаляет с узла и сообщает `recording_ready`.
 * Очередь выгрузки — в БД (`call_recording.status`), поэтому переживает переключение call-control.
 */
export class RecordingStore {
  private readonly s3: S3Client;

  constructor(
    private readonly o: {
      pool: Pool;
      logger: Logger;
      endpoint: string;
      bucket: string;
      accessKey: string;
      secretKey: string;
    },
  ) {
    this.s3 = new S3Client({
      endpoint: o.endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: o.accessKey, secretAccessKey: o.secretKey },
    });
  }

  async finished(node: string, rec: { name: string; duration?: number }): Promise<void> {
    await this.o.pool.query(
      `UPDATE call_recording SET status = 'pending_upload', duration_s = $3 WHERE node = $1 AND name = $2 AND status = 'recording'`,
      [node, rec.name, rec.duration ?? null],
    );
  }

  async failed(node: string, name: string): Promise<void> {
    await this.o.pool.query(`UPDATE call_recording SET status = 'failed' WHERE node = $1 AND name = $2`, [node, name]);
  }

  async uploadPending(node: string, ari: Ari): Promise<void> {
    const { rows } = await this.o.pool.query<{ id: string; name: string; conversation_id: string; created_at: Date }>(
      `SELECT id, name, conversation_id, created_at FROM call_recording
        WHERE node = $1 AND status = 'pending_upload' ORDER BY created_at LIMIT 3`,
      [node],
    );
    for (const r of rows) {
      try {
        const body = await ari.recordings.storedFile(r.name);
        const d = r.created_at;
        const key = `recordings/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${r.conversation_id}/${r.name}.wav`;
        await this.s3.send(
          new PutObjectCommand({ Bucket: this.o.bucket, Key: key, Body: body, ContentType: 'audio/wav' }),
        );
        const client = await this.o.pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `UPDATE call_recording SET status = 'uploaded', storage_key = $2, size_bytes = $3, uploaded_at = now() WHERE id = $1`,
            [r.id, key, body.length],
          );
          await emitConversation(client, CONVERSATION_EVENTS.updated, await loadRef(client, r.conversation_id), {
            action: 'recording_ready',
            recordingId: r.id,
          });
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw e;
        } finally {
          client.release();
        }
        await ari.recordings.deleteStored(r.name);
        this.o.logger.info({ recording: r.name, bytes: body.length }, 'запись разговора выгружена');
      } catch (err) {
        this.o.logger.warn({ err: String(err), recording: r.name }, 'не удалось выгрузить запись, повтор');
        await this.o.pool.query(
          `UPDATE call_recording SET attempts = attempts + 1,
             status = CASE WHEN attempts + 1 >= $2 THEN 'failed' ELSE status END WHERE id = $1`,
          [r.id, MAX_ATTEMPTS],
        );
      }
    }
  }
}
