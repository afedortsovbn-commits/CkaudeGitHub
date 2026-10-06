import { type AssistRequest, AssistResponseSchema, type AssistSuggestion, SECRET_MASK } from '@cc/contracts';
import { render } from '@cc/flow-engine';
import { isSealed, type Logger, openSecret, sealSecret } from '@cc/service-kit';
import type { Pool } from 'pg';
import { z } from 'zod';
import { badRequest } from '../lib/errors';

/**
 * Подсказки оператору (M-OP-10, M-AUTO-03, M-AI-01): реестр провайдеров Assist API.
 * - builtin — шаблоны ответов и статьи базы знаний: полнотекстовый поиск PostgreSQL (русский) по тексту
 *   последних сообщений клиента + совпадение темы обращения;
 * - openai — адаптер к OpenAI-совместимому API (локальный vLLM/Ollama), выключен по умолчанию: черновик ответа;
 * - http — внешний провайдер по контракту Assist API.
 * Провайдеры опрашиваются параллельно с таймаутом каждого; сбой или таймаут одного не мешает остальным —
 * оператор всегда видит подсказки встроенного провайдера. Включение/выключение — без перезапуска (читается
 * из БД при каждом запросе).
 */

export interface ProviderRow {
  id: string;
  name: string;
  kind: 'builtin' | 'openai' | 'http';
  config: Record<string, unknown>;
  functions: string[];
  timeout_ms: number;
  is_active: boolean;
}

const OpenAiConfig = z
  .object({
    baseUrl: z.string().url('Адрес API — например, http://ollama:11434/v1'),
    model: z.string().trim().min(1).max(200),
    apiKey: z.string().max(4000).optional(),
    systemPrompt: z.string().max(4000).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().min(16).max(4000).optional(),
    /** Разрешить адрес вне контура (облачная LLM) — только явным решением администратора (В-05). */
    allowExternal: z.boolean().optional(),
  })
  .strict();
const HttpConfig = z
  .object({
    url: z.string().url(),
    token: z.string().max(4000).optional(),
    allowExternal: z.boolean().optional(),
  })
  .strict();
const BuiltinConfig = z
  .object({
    templates: z.number().int().min(0).max(10).optional(),
    articles: z.number().int().min(0).max(10).optional(),
  })
  .strict();

const SECRET_FIELDS = ['apiKey', 'token'];

/** Адрес внутри контура: localhost, частные сети, имя без домена или в зонах .local/.internal/.lan. */
export function isInternalUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  if (!host.includes('.') || /\.(local|internal|lan|localdomain|corp|home\.arpa)$/.test(host)) return true;
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd')) return true;
  const ip = host.split('.').map(Number);
  if (ip.length === 4 && ip.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const [a, b] = ip as [number, number, number, number];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return false;
}

/** Проверка config по виду провайдера; ключи шифруются, пришедшая маска — «оставить прежний». */
export function prepareProvider(
  data: Record<string, unknown>,
  before: Record<string, unknown> | null,
  secretsKey: string | undefined,
): Record<string, unknown> {
  const kind = String(data.kind ?? before?.kind ?? '');
  if (before && data.kind !== undefined && data.kind !== before.kind)
    throw badRequest('Вид провайдера изменить нельзя — создайте новый');
  if (!before && kind === 'builtin') throw badRequest('Встроенный провайдер уже есть');
  if (data.config === undefined) return data;
  const prev = (before?.config ?? {}) as Record<string, unknown>;
  const config = { ...(data.config as Record<string, unknown>) };
  for (const k of SECRET_FIELDS) {
    if ((config[k] === SECRET_MASK || config[k] === undefined) && typeof prev[k] === 'string')
      config[k] = prev[k];
    else if (config[k] === '' || config[k] === null || config[k] === SECRET_MASK) delete config[k];
  }
  const schema = kind === 'openai' ? OpenAiConfig : kind === 'http' ? HttpConfig : BuiltinConfig;
  const r = schema.safeParse(config);
  if (!r.success)
    throw badRequest(
      'Ошибка в настройках провайдера',
      r.error.issues.map((i) => ({ path: `config.${i.path.join('.')}`, message: i.message })),
    );
  const out = { ...(r.data as Record<string, unknown>) };
  const url = String(out.baseUrl ?? out.url ?? '');
  if (url && !out.allowExternal && !isInternalUrl(url))
    throw badRequest(
      'Адрес вне контура: облачные LLM и внешние сервисы запрещены по умолчанию (В-05). ' +
        'Включите «Разрешить внешний адрес», если это согласовано.',
    );
  for (const k of SECRET_FIELDS) {
    if (typeof out[k] !== 'string' || !out[k] || isSealed(out[k] as string)) continue;
    if (!secretsKey) throw badRequest('Не задан SECRETS_KEY — ключ нельзя сохранить');
    out[k] = sealSecret(out[k] as string, secretsKey);
  }
  return { ...data, config: out };
}

export function maskProvider<T extends Record<string, unknown> | null>(row: T): T {
  if (!row || !row.config || typeof row.config !== 'object') return row;
  const config = { ...(row.config as Record<string, unknown>) };
  for (const k of SECRET_FIELDS) if (config[k]) config[k] = SECRET_MASK;
  return { ...row, config };
}

function secret(v: unknown, key: string | undefined): string {
  if (typeof v !== 'string' || !v) return '';
  if (!isSealed(v)) return v;
  if (!key) throw new Error('не задан SECRETS_KEY');
  return openSecret(v, key);
}

export interface AssistContext extends AssistRequest {
  userId: string;
  operatorName: string;
  topicPath: string[];
}

export interface ProviderOutcome {
  providerId: string;
  name: string;
  kind: string;
  ok: boolean;
  error?: string;
  ms: number;
  count: number;
}

const WORD = /[\p{L}\p{N}]{3,}/gu;

/** Запрос to_tsquery из слов текста: «слово1 | слово2 …» (только буквы и цифры — без синтаксиса tsquery). */
export function tsQueryOf(text: string, max = 30): string {
  const words = [...new Set((text.toLowerCase().replace(/ё/g, 'е').match(WORD) ?? []).slice(-200))];
  return words.slice(-max).join(' | ');
}

/** Переменные шаблонов ответа: {{client.name}}, {{operator.name}}, {{conversation.topic}}. */
export function templateVars(c: AssistContext): Record<string, string> {
  return {
    'client.name': c.contact.name ?? '',
    'client.phone': c.contact.phone ?? '',
    'operator.name': c.operatorName,
    'operator.firstName': c.operatorName.split(' ')[1] ?? c.operatorName,
    'conversation.topic': c.topic ?? '',
  };
}

/** Встроенный провайдер: шаблоны и статьи БЗ по тексту последних сообщений клиента и по теме обращения. */
export async function builtinSuggest(
  pool: Pool,
  c: AssistContext,
  config: Record<string, unknown>,
): Promise<AssistSuggestion[]> {
  const text = c.lastMessages
    .filter((m) => m.direction === 'in')
    .slice(-3)
    .map((m) => m.text)
    .join(' ');
  const q = tsQueryOf(text);
  const nT = Number(config.templates ?? 3);
  const nA = Number(config.articles ?? 3);
  const vars = templateVars(c);
  const templates = nT
    ? await pool.query<{ id: string; title: string; body: string; score: number }>(
        `SELECT t.id, t.title, t.body,
                LEAST(1, CASE WHEN $1 = '' THEN 0 ELSE ts_rank(t.search, to_tsquery('russian', $1), 32) * 4 END
                  + CASE WHEN t.topic_id = ANY ($2::uuid[]) THEN 0.5 ELSE 0 END) AS score
           FROM reply_template t
          WHERE t.is_active AND t.line = 'first' AND (t.owner_user_id IS NULL OR t.owner_user_id = $3)
            AND (cardinality(t.channel_kinds) = 0 OR $4 = ANY (t.channel_kinds))
            AND (($1 <> '' AND t.search @@ to_tsquery('russian', $1)) OR t.topic_id = ANY ($2::uuid[]))
          ORDER BY (CASE WHEN $1 = '' THEN 0 ELSE ts_rank(t.search, to_tsquery('russian', $1), 32) END
                    + CASE WHEN t.topic_id = ANY ($2::uuid[]) THEN 0.125 ELSE 0 END) DESC,
                   t.usage_count DESC LIMIT $5`,
        [q, c.topicPath, c.userId, c.channel, nT],
      )
    : { rows: [] };
  const articles = nA
    ? await pool.query<{ id: string; title: string; body: string; score: number }>(
        `SELECT a.id, a.title, a.body,
                LEAST(1, CASE WHEN $1 = '' THEN 0 ELSE ts_rank(a.search, to_tsquery('russian', $1), 32) * 4 END
                  + CASE WHEN a.topic_ids && $2::uuid[] THEN 0.4 ELSE 0 END) AS score
           FROM kb_article a
          WHERE a.is_active
            AND (($1 <> '' AND a.search @@ to_tsquery('russian', $1)) OR a.topic_ids && $2::uuid[])
          ORDER BY (CASE WHEN $1 = '' THEN 0 ELSE ts_rank(a.search, to_tsquery('russian', $1), 32) END
                    + CASE WHEN a.topic_ids && $2::uuid[] THEN 0.1 ELSE 0 END) DESC LIMIT $3`,
        [q, c.topicPath, nA],
      )
    : { rows: [] };
  return [
    ...templates.rows.map(
      (t): AssistSuggestion => ({
        type: 'template',
        title: t.title,
        text: render(t.body, vars),
        score: Math.max(0.05, Number(t.score)),
        source: 'builtin',
        refId: t.id,
      }),
    ),
    ...articles.rows.map(
      (a): AssistSuggestion => ({
        type: 'article',
        title: a.title,
        text: a.body,
        score: Math.max(0.05, Number(a.score) * 0.95),
        source: 'builtin',
        refId: a.id,
      }),
    ),
  ];
}

const DEFAULT_PROMPT =
  'Ты — помощник оператора контакт-центра. Предложи короткий вежливый ответ клиенту на русском языке ' +
  'от имени оператора. Не выдумывай факты: если данных не хватает — предложи уточнить вопрос. ' +
  'Верни только текст ответа.';

/** OpenAI-совместимый /chat/completions: черновик ответа по последним сообщениям (+ статьи БЗ как контекст). */
async function openAiDraft(
  p: ProviderRow,
  c: AssistContext,
  secretsKey: string | undefined,
  kb: AssistSuggestion[],
): Promise<AssistSuggestion[]> {
  const cfg = p.config;
  const key = secret(cfg.apiKey, secretsKey);
  const context = kb.length
    ? `\n\nСправка из базы знаний:\n${kb
        .slice(0, 2)
        .map((a) => `— ${a.title}: ${a.text.slice(0, 1500)}`)
        .join('\n')}`
    : '';
  const messages = [
    { role: 'system', content: `${String(cfg.systemPrompt || DEFAULT_PROMPT)}${context}` },
    ...c.lastMessages.slice(-10).map((m) => ({
      role: m.direction === 'in' ? 'user' : 'assistant',
      content: m.text.slice(0, 4000),
    })),
  ];
  const r = await fetch(`${String(cfg.baseUrl).replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: cfg.temperature ?? 0.3,
      max_tokens: cfg.maxTokens ?? 400,
    }),
    signal: AbortSignal.timeout(p.timeout_ms),
    redirect: 'error',
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
  const text = j.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('пустой ответ модели');
  return [{ type: 'draft', title: `Черновик: ${p.name}`, text, score: 0.6, source: p.id }];
}

/** Внешний провайдер по контракту Assist API. */
async function httpSuggest(
  p: ProviderRow,
  c: AssistContext,
  secretsKey: string | undefined,
): Promise<AssistSuggestion[]> {
  const token = secret(p.config.token, secretsKey);
  const body: AssistRequest = {
    conversationId: c.conversationId,
    channel: c.channel,
    topic: c.topic,
    lastMessages: c.lastMessages,
    contact: c.contact,
    function: c.function,
  };
  const r = await fetch(String(p.config.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(p.timeout_ms),
    redirect: 'error',
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const parsed = AssistResponseSchema.safeParse(await r.json());
  if (!parsed.success) throw new Error('ответ не по контракту Assist API');
  return parsed.data.suggestions.map((s) => ({ ...s, source: p.id }));
}

function errText(e: unknown, timeoutMs: number): string {
  const err = e as Error;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return `нет ответа за ${timeoutMs} мс`;
  return err?.message || String(e);
}

/**
 * Опрос провайдеров, у которых включена функция fn. Каждый — со своим таймаутом; ошибки не пробрасываются,
 * а возвращаются в outcomes (панель показывает «провайдер недоступен», подсказки остальных — как обычно).
 */
export async function collectSuggestions(
  deps: { pool: Pool; secretsKey?: string; logger?: Logger },
  c: AssistContext,
  fn: 'suggest' | 'draft',
): Promise<{ suggestions: AssistSuggestion[]; providers: ProviderOutcome[] }> {
  const { rows: providers } = await deps.pool.query<ProviderRow>(
    `SELECT id, name, kind, config, functions, timeout_ms, is_active FROM assist_provider
      WHERE is_active AND $1 = ANY (functions) ORDER BY sort_order, name`,
    [fn],
  );
  // Статьи БЗ нужны и встроенному провайдеру, и LLM как контекст — ищем один раз.
  let builtinResult: Promise<AssistSuggestion[]> | undefined;
  const builtin = (cfg: Record<string, unknown>) =>
    (builtinResult ??= builtinSuggest(deps.pool, { ...c, function: 'suggest' }, cfg));
  const outcomes = await Promise.all(
    providers.map(async (p): Promise<{ out: ProviderOutcome; list: AssistSuggestion[] }> => {
      const started = Date.now();
      try {
        const list =
          p.kind === 'builtin'
            ? await builtin(p.config)
            : p.kind === 'openai'
              ? await openAiDraft(
                  p,
                  c,
                  deps.secretsKey,
                  (await builtin({}).catch(() => [])).filter((s) => s.type === 'article'),
                )
              : await httpSuggest(p, c, deps.secretsKey);
        return {
          out: {
            providerId: p.id,
            name: p.name,
            kind: p.kind,
            ok: true,
            ms: Date.now() - started,
            count: list.length,
          },
          list,
        };
      } catch (e) {
        const error = errText(e, p.timeout_ms);
        deps.logger?.info({ provider: p.name, error }, 'провайдер подсказок недоступен');
        return {
          out: {
            providerId: p.id,
            name: p.name,
            kind: p.kind,
            ok: false,
            error,
            ms: Date.now() - started,
            count: 0,
          },
          list: [],
        };
      }
    }),
  );
  const seen = new Set<string>();
  const suggestions = outcomes
    .flatMap((o) => o.list)
    .filter((s) => {
      const k = `${s.type}:${s.refId ?? s.text}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  return { suggestions, providers: outcomes.map((o) => o.out) };
}

/** Проверка связи с провайдером из админки (фиксируется в last_check_*). */
export async function checkProvider(
  deps: { pool: Pool; secretsKey?: string },
  p: ProviderRow,
): Promise<{ ok: boolean; error?: string; ms: number; sample?: string }> {
  const started = Date.now();
  const ctx: AssistContext = {
    conversationId: '00000000-0000-4000-8000-000000000000',
    channel: 'webchat',
    topic: null,
    lastMessages: [{ direction: 'in', text: 'Здравствуйте! Проверка связи.', at: new Date().toISOString() }],
    contact: { name: null, phone: null },
    function: 'suggest',
    userId: '00000000-0000-4000-8000-000000000000',
    operatorName: 'Оператор',
    topicPath: [],
  };
  let res: { ok: boolean; error?: string; ms: number; sample?: string };
  try {
    const list =
      p.kind === 'openai'
        ? await openAiDraft(p, ctx, deps.secretsKey, [])
        : p.kind === 'http'
          ? await httpSuggest(p, ctx, deps.secretsKey)
          : await builtinSuggest(deps.pool, ctx, p.config);
    res = { ok: true, ms: Date.now() - started, sample: list[0]?.text.slice(0, 300) };
  } catch (e) {
    res = { ok: false, error: errText(e, p.timeout_ms), ms: Date.now() - started };
  }
  await deps.pool.query(
    `UPDATE assist_provider SET last_check_at = now(), last_check_ok = $2, last_check_error = $3 WHERE id = $1`,
    [p.id, res.ok, res.error ?? null],
  );
  return res;
}
