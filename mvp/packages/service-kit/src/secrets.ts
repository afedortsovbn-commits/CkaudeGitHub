import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const PREFIX = 'enc:v1:';

function key(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

/**
 * Шифрование секретов интеграций в БД (02-архитектура 9): AES-256-GCM, ключ — из переменной окружения
 * SECRETS_KEY. Значение без префикса считается незашифрованным (совместимость с записями до шифрования).
 */
export function sealSecret(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(secret), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), data]).toString('base64');
}

export function openSecret(value: string, secret: string): string {
  if (!value.startsWith(PREFIX)) return value;
  const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
  const d = createDecipheriv('aes-256-gcm', key(secret), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

export const isSealed = (value: unknown): boolean => typeof value === 'string' && value.startsWith(PREFIX);
