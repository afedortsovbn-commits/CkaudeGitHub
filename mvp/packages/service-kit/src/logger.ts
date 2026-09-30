import { hostname } from 'node:os';
import pino, { type Logger } from 'pino';
import { maskPii, maskPiiDeep } from './pii';
import { currentCorrelationId } from './trace';

export type { Logger };

/**
 * JSON-логи (M-NFR-04) с маскированием секретов и персональных данных (FS-LOG-03, M-NFR-07): телефоны, email,
 * тексты и имена клиентов в строке сообщения и в полях записи скрываются или маскируются (`pii.ts`).
 * `LOG_PII=1` — отключить маскирование (только для отладки на тестовом стенде).
 */
export function createLogger(opts: {
  service: string;
  version: string;
  level?: string;
  maskPii?: boolean;
  /** Поток вывода (по умолчанию stdout) — для тестов. */
  stream?: NodeJS.WritableStream;
}): Logger {
  const mask = opts.maskPii ?? process.env.LOG_PII !== '1';
  const options: pino.LoggerOptions = {
    level: opts.level ?? 'info',
    base: { service: opts.service, version: opts.version, instance: hostname() },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'msg',
    // correlation-id текущего запроса/сообщения (trace.ts) — в каждой строке журнала.
    mixin: () => {
      const id = currentCorrelationId();
      return id ? { correlationId: id } : {};
    },
    formatters: {
      level: (label) => ({ level: label }),
      ...(mask ? { log: (obj: Record<string, unknown>) => maskPiiDeep(obj) as Record<string, unknown> } : {}),
    },
    ...(mask
      ? {
          hooks: {
            logMethod(args: unknown[], method: (...a: unknown[]) => void) {
              method.apply(
                this,
                args.map((a) => (typeof a === 'string' ? maskPii(a) : a)),
              );
            },
          },
        }
      : {}),
    redact: {
      paths: [
        'password',
        '*.password',
        'token',
        '*.token',
        'authorization',
        '*.authorization',
        'req.headers.authorization',
        'req.headers.cookie',
      ],
      censor: '[скрыто]',
    },
  };
  return opts.stream ? pino(options, opts.stream as pino.DestinationStream) : pino(options);
}
