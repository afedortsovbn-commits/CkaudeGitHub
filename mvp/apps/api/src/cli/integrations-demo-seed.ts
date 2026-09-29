import { newId } from '@cc/contracts';
import { sealSecret } from '@cc/service-kit';
import type { PoolClient } from 'pg';
import { hashKey } from '../ext/api-key';

export const DEMO_EXTBOT_KEY = 'demo-webchat-extbot';

/** Ключи и секреты демо-стенда — известны моку (mock-selfservice); на рабочем стенде не создаются. */
export const DEMO_INTEGRATION_DEFAULTS = {
  analyzerKey: 'cck_demo_analyzer_key_change_me_0123456789',
  analyzerSecret: 'whsec_demo_analyzer_change_me',
  botKey: 'cck_demo_bot_key_change_me_0123456789abcdef',
  botSecret: 'whsec_demo_bot_change_me',
  formKey: 'cck_demo_form_key_change_me_0123456789abcd',
  formSecret: 'whsec_demo_form_change_me',
};

/**
 * Демо Ф9 (01, разд. 5, сценарий 8): анализатор завершённых обращений (webhook conversation.closed → мок
 * пишет результат через API; подписка выключена — включается в админке), внешний эхо-бот на отдельном канале
 * «Чат на сайте с внешним ботом» (ключ demo-webchat-extbot), внешний канал «Форма сайта (API)» с ключом и
 * подпиской на ответы операторов. Идемпотентно: канал с внешним ботом уже есть — пропуск.
 */
export async function seedIntegrationsDemo(
  tx: PoolClient,
  o: { mockUrl: string; secretsKey?: string; keys?: Partial<typeof DEMO_INTEGRATION_DEFAULTS> },
): Promise<boolean> {
  const exists = await tx.query(`SELECT 1 FROM channel WHERE config ->> 'public_key' = $1`, [
    DEMO_EXTBOT_KEY,
  ]);
  if (exists.rowCount) return false;
  const q = await tx.query<{ id: string }>(`SELECT id FROM queue WHERE name = 'Общая' LIMIT 1`);
  const queue = q.rows[0]?.id;
  if (!queue) return false;
  const k = { ...DEMO_INTEGRATION_DEFAULTS, ...o.keys };
  const seal = (s: string) => (o.secretsKey ? sealSecret(s, o.secretsKey) : s);
  const base = o.mockUrl.replace(/\/$/, '');

  const key = async (name: string, value: string, permissions: string[], channelId: string | null = null) =>
    tx.query(
      `INSERT INTO api_key (id, name, prefix, key_hash, permissions, channel_id) VALUES ($1, $2, $3, $4, $5, $6)`,
      [newId(), name, value.slice(0, 12), hashKey(value), permissions, channelId],
    );
  const sub = async (s: {
    kind: 'events' | 'bot';
    name: string;
    url: string;
    secret: string;
    events?: string[];
    channels?: string[];
    active: boolean;
  }) => {
    const id = newId();
    await tx.query(
      `INSERT INTO webhook_subscription (id, kind, name, url, secret, event_types, channel_ids, bot_timeout_s, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 20, $8)`,
      [id, s.kind, s.name, s.url, seal(s.secret), s.events ?? [], s.channels ?? [], s.active],
    );
    return id;
  };

  // ---------- анализатор завершённых обращений (M-AI-03)
  await key('Демо: анализатор обращений', k.analyzerKey, ['conversations.read', 'conversations.write']);
  await sub({
    kind: 'events',
    name: 'Демо: анализатор (закрытые обращения)',
    url: `${base}/analyzer/webhook`,
    secret: k.analyzerSecret,
    events: ['conversation.closed'],
    active: false,
  });

  // ---------- внешний бот (Bot Gateway, M-AI-02)
  await key('Демо: внешний эхо-бот', k.botKey, ['bot.reply']);
  const botId = await sub({
    kind: 'bot',
    name: 'Демо: эхо-бот',
    url: `${base}/bot/webhook`,
    secret: k.botSecret,
    active: true,
  });
  await tx.query(
    `INSERT INTO channel (id, kind, name, queue_id, bot_webhook_id, config) VALUES ($1, 'webchat', $2, $3, $4, $5)`,
    [
      newId(),
      'Чат на сайте с внешним ботом (демо)',
      queue,
      botId,
      JSON.stringify({
        public_key: DEMO_EXTBOT_KEY,
        allowed_origins: ['*'],
        consent_version: '1',
        consent_text:
          'Я согласен(на) на обработку персональных данных в соответствии с политикой конфиденциальности.',
        greeting: 'Здравствуйте! Вам ответит бот, а при необходимости — оператор.',
        max_file_mb: 10,
      }),
    ],
  );

  // ---------- внешний канал (M-CH-09): форма сайта по ключу, ответы операторов — webhook
  const form = newId();
  await tx.query(
    `INSERT INTO channel (id, kind, name, queue_id) VALUES ($1, 'api', 'Форма сайта (API, демо)', $2)`,
    [form, queue],
  );
  await key('Демо: форма сайта', k.formKey, ['inbound', 'conversations.read'], form);
  await sub({
    kind: 'events',
    name: 'Демо: ответы на форму сайта',
    url: `${base}/hooks/site-form`,
    secret: k.formSecret,
    events: ['message.created'],
    channels: [form],
    active: true,
  });
  return true;
}
