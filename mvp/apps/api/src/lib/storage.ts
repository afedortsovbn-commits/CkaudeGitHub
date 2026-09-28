import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';

/** Файлы (вложения, записи разговоров) в S3-совместимом хранилище внутри контура. */
export interface Storage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<{ body: Readable; contentType?: string; length?: number }>;
  ensureBucket(): Promise<void>;
}

export function createS3Storage(o: {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}): Storage {
  const s3 = new S3Client({
    endpoint: o.endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: o.accessKey, secretAccessKey: o.secretKey },
  });
  return {
    async put(key, body, contentType) {
      await s3.send(
        new PutObjectCommand({ Bucket: o.bucket, Key: key, Body: body, ContentType: contentType }),
      );
    },
    async get(key) {
      const r = await s3.send(new GetObjectCommand({ Bucket: o.bucket, Key: key }));
      return { body: r.Body as Readable, contentType: r.ContentType, length: r.ContentLength };
    },
    async ensureBucket() {
      try {
        await s3.send(new HeadBucketCommand({ Bucket: o.bucket }));
      } catch {
        await s3.send(new CreateBucketCommand({ Bucket: o.bucket })).catch((e: unknown) => {
          if (!String(e).includes('BucketAlready')) throw e;
        });
      }
    },
  };
}

/** Хранилище в памяти — для тестов. */
export function createMemoryStorage(): Storage {
  const m = new Map<string, { body: Buffer; contentType: string }>();
  return {
    async put(key, body, contentType) {
      m.set(key, { body, contentType });
    },
    async get(key) {
      const v = m.get(key);
      if (!v) throw new Error('not found');
      const { Readable } = await import('node:stream');
      return { body: Readable.from(v.body), contentType: v.contentType, length: v.body.length };
    },
    async ensureBucket() {},
  };
}
