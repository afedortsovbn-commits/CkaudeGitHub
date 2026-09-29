import { type IntegrationReply, type IntegrationRequest, newId, SECRET_MASK } from '@cc/contracts';
import { getPath, render, toVar } from '@cc/flow-engine';
import { isSealed, type Logger, openSecret, sealSecret } from '@cc/service-kit';
import type { Pool } from 'pg';
import { z } from 'zod';
import { badRequest } from '../lib/errors';

/**
 * Интеграционные операции (M-INT-03, 02-архитектура 7): описание HTTP-операции внешней системы в админке
 * (метод, URL-шаблон, заголовки, авторизация, тело, маппинг входа и выхода, таймаут, фолбэк) и её
 * выполнение. Выполняет только api: здесь секреты и журнал; IVR (call-control) и боты вызывают api через NATS.
 */

const name = z
  .string()
  .trim()
  .regex(/^[A-Za-z_][\w.-]{0,63}$/, 'Имя: латиница, цифры, _ . -');
export const IntegrationAuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('bearer'), secret: z.string().max(4000).optional() }),
  z.object({
    type: z.literal('basic'),
    username: z.string().max(200),
    secret: z.string().max(4000).optional(),
  }),
  z.object({
    type: z.literal('header'),
    header: z.string().trim().min(1).max(100),
    secret: z.string().max(4000).optional(),
  }),
]);
export const IntegrationInputsSchema = z
  .array(z.object({ name, label: z.string().max(200).default(''), sample: z.string().max(500).optional() }))
  .max(20);
export const IntegrationOutputsSchema = z
  .array(z.object({ name, label: z.string().max(200).default(''), path: z.string().trim().min(1).max(300) }))
  .max(50);

type Auth = z.infer<typeof IntegrationAuthSchema>;

/** Секрет авторизации шифруется при записи; пришедшая маска — «оставить прежний». */
export function prepareIntegration(
  data: Record<string, unknown>,
  before: Record<string, unknown> | null,
  secretsKey: string | undefined,
): Record<string, unknown> {
  if (typeof data.url === 'string' && !/^https?:\/\//i.test(data.url))
    throw badRequest('URL должен начинаться с http:// или https://');
  if (data.auth === undefined) return data;
  const auth = { ...(data.auth as Record<string, unknown>) };
  const prev = (before?.auth ?? {}) as Record<string, unknown>;
  if ('secret' in auth || auth.type !== 'none') {
    if ((auth.secret === SECRET_MASK || auth.secret === undefined) && typeof prev.secret === 'string')
      auth.secret = prev.secret;
    else if (typeof auth.secret === 'string' && auth.secret && !isSealed(auth.secret)) {
      if (!secretsKey) throw badRequest('Не задан SECRETS_KEY — секрет нельзя сохранить');
      auth.secret = sealSecret(auth.secret, secretsKey);
    }
  }
  return { ...data, auth };
}

export function maskIntegration<T extends Record<string, unknown> | null>(row: T): T {
  if (!row || !row.auth || typeof row.auth !== 'object') return row;
  const auth = { ...(row.auth as Record<string, unknown>) };
  if (auth.secret) auth.secret = SECRET_MASK;
  return { ...row, auth };
}

interface OpRow {
  id: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  auth: Auth;
  body: string | null;
  outputs: { name: string; path: string }[];
  timeout_ms: number;
  fallback: Record<string, string>;
}

const jsonEscape = (v: string) => JSON.stringify(v).slice(1, -1);

export interface ExecuteResult extends IntegrationReply {
  /** Ответ внешней системы — только для тестового запуска в админке (в журнал не пишется). */
  response?: unknown;
}

export async function executeOperation(
  deps: { pool: Pool; secretsKey?: string; logger?: Logger },
  req: IntegrationRequest,
): Promise<ExecuteResult> {
  const started = Date.now();
  const { rows } = await deps.pool.query<OpRow>(
    `SELECT id, method, url, headers, auth, body, outputs, timeout_ms, fallback FROM integration_op
      WHERE id = $1 AND is_active`,
    [req.operationId],
  );
  const op = rows[0];
  if (!op) return { ok: false, outputs: {}, error: 'Операция не найдена или отключена', durationMs: 0 };
  const vars = req.input ?? {};
  let res: ExecuteResult;
  try {
    const url = render(op.url, vars, encodeURIComponent);
    const headers: Record<string, string> = { accept: 'application/json' };
    for (const [k, v] of Object.entries(op.headers ?? {})) headers[k] = render(String(v), vars);
    const secret = () => {
      const s = 'secret' in op.auth ? op.auth.secret : undefined;
      if (!s) return '';
      if (!isSealed(s)) return s;
      if (!deps.secretsKey) throw new Error('не задан SECRETS_KEY');
      return openSecret(s, deps.secretsKey);
    };
    if (op.auth.type === 'bearer') headers.authorization = `Bearer ${secret()}`;
    else if (op.auth.type === 'basic')
      headers.authorization = `Basic ${Buffer.from(`${op.auth.username}:${secret()}`).toString('base64')}`;
    else if (op.auth.type === 'header') headers[op.auth.header] = secret();
    let body: string | undefined;
    if (op.body && op.method !== 'GET') {
      body = render(op.body, vars, jsonEscape);
      headers['content-type'] ??= 'application/json';
    }
    const r = await fetch(url, {
      method: op.method,
      headers,
      body,
      signal: AbortSignal.timeout(op.timeout_ms),
      redirect: 'error',
    });
    const text = await r.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = undefined;
    }
    if (!r.ok) {
      res = {
        ok: false,
        outputs: {},
        error: `HTTP ${r.status}`,
        httpStatus: r.status,
        durationMs: 0,
        response: json,
      };
    } else if (json === undefined) {
      res = { ok: false, outputs: {}, error: 'Ответ не в формате JSON', httpStatus: r.status, durationMs: 0 };
    } else {
      const outputs: Record<string, string> = {};
      for (const o of op.outputs ?? []) outputs[o.name] = toVar(getPath(json, o.path));
      res = { ok: true, outputs, httpStatus: r.status, durationMs: 0, response: json };
    }
  } catch (err) {
    const e = err as Error;
    const timeout = e.name === 'TimeoutError' || e.name === 'AbortError';
    res = {
      ok: false,
      outputs: {},
      error: timeout ? `Нет ответа за ${op.timeout_ms} мс` : `Ошибка соединения: ${e.message}`,
      durationMs: 0,
    };
  }
  if (!res.ok) res.outputs = { ...(op.fallback ?? {}) };
  res.durationMs = Date.now() - started;
  await deps.pool
    .query(
      `INSERT INTO integration_log (id, operation_id, source, conversation_id, call_id, user_id, ok, http_status, duration_ms, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        newId(),
        op.id,
        req.source,
        req.conversationId ?? null,
        req.callId ?? null,
        req.userId ?? null,
        res.ok,
        res.httpStatus ?? null,
        res.durationMs,
        res.error ?? null,
      ],
    )
    .catch((err: unknown) =>
      deps.logger?.warn({ err: String(err) }, 'не удалось записать журнал интеграции'),
    );
  if (!res.ok) deps.logger?.info({ operationId: op.id, error: res.error }, 'интеграционная операция: ошибка');
  return res;
}
