/* eslint-disable no-console */
/**
 * Резервное копирование S3-хранилища (записи разговоров, вложения, аудио IVR) — M-NFR-06, Ф12.
 * Запуск из образа api (ops/backup.sh, ops/restore.sh):
 *   docker compose run --rm --no-deps -v <каталог>:/backup migrate node dist/cli/storage-backup.js <команда> …
 * Команды:
 *   export <каталог> [бакет]     — все объекты в <каталог>/objects/<ключ> и manifest.json (размер, sha256, тип)
 *   import <каталог> [бакет]     — загрузить объекты из копии (бакет создаётся; существующие ключи перезаписываются)
 *   verify <каталог> [бакет]     — каждый объект копии есть в бакете с тем же размером и sha256
 *   drop <бакет>                 — удалить бакет вместе с объектами (проверочное восстановление)
 * Бакет по умолчанию — S3_BUCKET. Подключение — S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY.
 */
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

export interface ManifestEntry {
  key: string;
  size: number;
  sha256: string;
  contentType?: string;
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function client(): S3Client {
  return new S3Client({
    endpoint: process.env.S3_ENDPOINT ?? 'http://s3:8333',
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY ?? 'cc',
      secretAccessKey: process.env.S3_SECRET_KEY ?? 'cc-secret',
    },
  });
}

async function* keys(s3: S3Client, bucket: string): AsyncGenerator<string> {
  let token: string | undefined;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
    for (const o of r.Contents ?? []) if (o.Key) yield o.Key;
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
}

async function getObject(s3: S3Client, bucket: string, key: string) {
  const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = Buffer.from(await r.Body!.transformToByteArray());
  return { body, contentType: r.ContentType };
}

/** Путь файла объекта внутри каталога копии; ключ не может выйти за его пределы. */
function objectPath(dir: string, key: string): string {
  const root = resolve(dir, 'objects');
  const p = resolve(root, key);
  if (!p.startsWith(root + sep)) throw new Error(`недопустимый ключ объекта: ${key}`);
  return p;
}

async function ensureBucket(s3: S3Client, bucket: string) {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

async function readManifest(dir: string): Promise<ManifestEntry[]> {
  return JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as ManifestEntry[];
}

export async function storageBackup(argv: string[]): Promise<Record<string, unknown>> {
  const [cmd, dir, bucketArg] = argv;
  const bucket = bucketArg ?? process.env.S3_BUCKET ?? 'cc-files';
  const s3 = client();
  switch (cmd) {
    case 'export': {
      if (!dir) throw new Error('укажите каталог');
      const manifest: ManifestEntry[] = [];
      let bytes = 0;
      for await (const key of keys(s3, bucket)) {
        const { body, contentType } = await getObject(s3, bucket, key);
        const p = objectPath(dir, key);
        await mkdir(dirname(p), { recursive: true });
        await writeFile(p, body);
        manifest.push({ key, size: body.length, sha256: sha(body), contentType });
        bytes += body.length;
      }
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1));
      return { bucket, objects: manifest.length, bytes };
    }
    case 'import': {
      if (!dir) throw new Error('укажите каталог');
      await ensureBucket(s3, bucket);
      const manifest = await readManifest(dir);
      for (const m of manifest) {
        const body = await readFile(objectPath(dir, m.key));
        if (sha(body) !== m.sha256) throw new Error(`файл копии повреждён: ${m.key}`);
        await s3.send(
          new PutObjectCommand({ Bucket: bucket, Key: m.key, Body: body, ContentType: m.contentType }),
        );
      }
      return { bucket, objects: manifest.length };
    }
    case 'verify': {
      if (!dir) throw new Error('укажите каталог');
      const manifest = await readManifest(dir);
      const missing: string[] = [];
      const mismatched: string[] = [];
      for (const m of manifest) {
        const got = await getObject(s3, bucket, m.key).catch(() => null);
        if (!got) missing.push(m.key);
        else if (got.body.length !== m.size || sha(got.body) !== m.sha256) mismatched.push(m.key);
      }
      return {
        bucket,
        checked: manifest.length,
        missing,
        mismatched,
        ok: !missing.length && !mismatched.length,
      };
    }
    case 'drop': {
      const b = dir;
      if (!b) throw new Error('укажите бакет');
      if (b === (process.env.S3_BUCKET ?? 'cc-files')) throw new Error('рабочий бакет удалять нельзя');
      let n = 0;
      for await (const key of keys(s3, b)) {
        await s3.send(new DeleteObjectCommand({ Bucket: b, Key: key }));
        n++;
      }
      await s3.send(new DeleteBucketCommand({ Bucket: b }));
      return { bucket: b, deleted: n };
    }
    default:
      throw new Error('команды: export | import | verify | drop');
  }
}

if (require.main === module) {
  storageBackup(process.argv.slice(2))
    .then((r) => {
      console.log(JSON.stringify(r));
      process.exit(r.ok === false ? 2 : 0);
    })
    .catch((e: unknown) => {
      console.error(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
      process.exit(1);
    });
}
