import { hostname } from 'node:os';
import pino, { type Logger } from 'pino';

export type { Logger };

/** JSON-логи с маскированием секретов (M-NFR-04, FS-LOG-03). */
export function createLogger(opts: { service: string; version: string; level?: string }): Logger {
  return pino({
    level: opts.level ?? 'info',
    base: { service: opts.service, version: opts.version, instance: hostname() },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'msg',
    formatters: { level: (label) => ({ level: label }) },
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
  });
}
