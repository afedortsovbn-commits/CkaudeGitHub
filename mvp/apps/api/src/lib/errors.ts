import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { DomainError } from '@cc/domain';
import { ZodError, type ZodTypeAny, type z } from 'zod';

export class ApiError extends HttpException {
  constructor(status: number, code: string, message: string, details?: unknown) {
    super({ error: code, message, details }, status);
  }
}
export const notFound = (what = 'Запись') => new ApiError(404, 'not_found', `${what} не найдена`);
export const forbidden = () => new ApiError(403, 'forbidden', 'Недостаточно прав');
export const badRequest = (message: string, details?: unknown) =>
  new ApiError(400, 'bad_request', message, details);

export function parse<S extends ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw badRequest(
      'Ошибка в данных запроса',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}

interface PgError {
  code?: string;
  detail?: string;
  constraint?: string;
}

/** Единый формат ошибок: {error, message, details}. Ошибки PostgreSQL переводятся в 409/400. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  constructor(private readonly log?: (err: unknown) => void) {}

  catch(err: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    if (err instanceof HttpException) {
      const body = err.getResponse();
      reply
        .status(err.getStatus())
        .send(typeof body === 'string' ? { error: 'http_error', message: body } : body);
      return;
    }
    if (err instanceof DomainError) {
      reply.status(err.status).send({ error: err.code, message: err.message });
      return;
    }
    if (err instanceof ZodError) {
      reply.status(400).send({ error: 'bad_request', message: 'Ошибка в данных', details: err.issues });
      return;
    }
    const pg = err as PgError;
    if (pg?.code === '23505') {
      reply
        .status(409)
        .send({ error: 'conflict', message: 'Такая запись уже существует', details: pg.detail });
      return;
    }
    if (pg?.code === '23503') {
      reply.status(409).send({
        error: 'conflict',
        message: 'Связанная запись не найдена или используется',
        details: pg.detail,
      });
      return;
    }
    if (pg?.code === '23514' || pg?.code === '22P02' || pg?.code === 'P0001') {
      reply
        .status(400)
        .send({ error: 'bad_request', message: 'Недопустимое значение', details: pg.detail ?? String(err) });
      return;
    }
    this.log?.(err);
    reply.status(500).send({ error: 'internal', message: 'Внутренняя ошибка' });
  }
}
