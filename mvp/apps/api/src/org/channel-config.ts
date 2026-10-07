import { randomBytes } from 'node:crypto';
import {
  CHANNEL_SECRET_KEYS,
  EmailChannelConfigSchema,
  RocketDataChannelConfigSchema,
  SECRET_MASK,
  TelegramChannelConfigSchema,
  VoiceChannelConfigSchema,
} from '@cc/contracts';
import { isSealed, openSecret, sealSecret } from '@cc/service-kit';
import { z, type ZodTypeAny } from 'zod';
import { badRequest } from '../lib/errors';

type Config = Record<string, unknown>;

/** Настройки веб-чата и чата в приложении (Ф2). */
const ChatChannelConfigSchema = z
  .object({
    public_key: z.string().min(8).max(64).optional(),
    allowed_origins: z.array(z.string().max(200)).optional(),
    consent_text: z.string().max(4000).optional(),
    consent_version: z.string().max(32).optional(),
    greeting: z.string().max(1000).optional(),
    max_file_mb: z.number().int().min(1).max(50).optional(),
    /** Показывать клиенту, что оператор печатает (по умолчанию — да). */
    show_typing: z.boolean().optional(),
    app_secret: z.string().min(16).max(200).optional(),
    /** Анкета перед чатом (п.2 требований): какие сведения о клиенте спросить и какие из них обязательны. */
    prechat_fields: z
      .array(z.object({ key: z.enum(['name', 'phone', 'email']), required: z.boolean() }).strict())
      .max(3)
      .refine((a) => new Set(a.map((f) => f.key)).size === a.length, 'Поле анкеты указано дважды')
      .optional(),
  })
  .passthrough();

const SCHEMAS: Record<string, ZodTypeAny> = {
  webchat: ChatChannelConfigSchema,
  app: ChatChannelConfigSchema,
  api: ChatChannelConfigSchema,
  telegram: TelegramChannelConfigSchema,
  email: EmailChannelConfigSchema,
  voice: VoiceChannelConfigSchema,
  // Ф13: отзывы с карт — подключение к API Rocket Data.
  review: RocketDataChannelConfigSchema,
};

const SECRETS: readonly string[] = CHANNEL_SECRET_KEYS;

/**
 * Готовит config канала к записи: проверка по схеме типа канала, секреты шифруются (M-NFR, 02-архитектура 9).
 * Пришедшая маска или отсутствующий секрет при изменении означают «оставить прежнее значение».
 * Для webhook-режима Telegram секрет проверки запросов генерируется автоматически.
 */
export function prepareChannelConfig(
  kind: string,
  input: Config,
  before: Config | null,
  secretsKey: string | undefined,
): Config {
  const schema = SCHEMAS[kind];
  if (!schema) throw badRequest(`Неизвестный тип канала: ${kind}`);
  const config: Config = { ...input };
  const kept = new Set<string>();
  for (const k of SECRETS) {
    const v = config[k];
    if ((v === SECRET_MASK || v === undefined) && before && typeof before[k] === 'string') {
      config[k] = before[k];
      kept.add(k);
    } else if (v === SECRET_MASK || v === '' || v === null) delete config[k];
  }
  if (kind === 'telegram' && config.mode === 'webhook' && !config.webhook_secret)
    config.webhook_secret = randomBytes(24).toString('hex');

  // Проверяем открытые значения: прежние секреты расшифровываем (или подставляем заглушку, если ключ сменился).
  const plain: Config = { ...config };
  for (const k of kept) plain[k] = reveal(String(config[k]), secretsKey) ?? 'x'.repeat(32);
  const r = schema.safeParse(plain);
  if (!r.success) {
    throw badRequest(
      'Ошибка в настройках канала',
      r.error.issues.map((i) => ({ path: `config.${i.path.join('.')}`, message: i.message })),
    );
  }
  const out: Config = { ...(r.data as Config) };
  for (const k of SECRETS) {
    if (typeof out[k] !== 'string') continue;
    if (kept.has(k))
      out[k] = config[k]; // как было (зашифровано)
    else if (secretsKey && !isSealed(out[k])) out[k] = sealSecret(String(out[k]), secretsKey);
  }
  return out;
}

function reveal(value: string, key: string | undefined): string | null {
  if (!isSealed(value)) return value;
  if (!key) return null;
  try {
    return openSecret(value, key);
  } catch {
    return null;
  }
}

/** Секреты канала в ответах api и в журнале аудита не показываются. */
export function maskChannelRow<T extends Record<string, unknown> | null>(row: T): T {
  if (!row || typeof row.config !== 'object' || row.config === null) return row;
  const config = { ...(row.config as Config) };
  for (const k of SECRETS) if (typeof config[k] === 'string' && config[k]) config[k] = SECRET_MASK;
  return { ...row, config };
}
