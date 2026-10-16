import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { ExtCommentsController } from '../moderation/comments.controller';
import { ExtController } from './ext.controller';
import { buildOpenApi } from './openapi';

/** Каждый маршрут публичного API описан в OpenAPI, и в описании нет лишних путей. */
describe('OpenAPI публичного API', () => {
  const routesOf = (ctrl: { prototype: object }) => {
    const base = Reflect.getMetadata(PATH_METADATA, ctrl) as string;
    return Object.getOwnPropertyNames(ctrl.prototype)
      .filter((name) => name !== 'constructor')
      .map((name) => (ctrl.prototype as unknown as Record<string, unknown>)[name])
      .filter((fn): fn is object => typeof fn === 'function' && Reflect.hasMetadata(PATH_METADATA, fn))
      .map((fn) => {
        const path = Reflect.getMetadata(PATH_METADATA, fn) as string;
        const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, fn) as number]!.toLowerCase();
        return `${method} ${`/${base}/${path}`.replace(/\/+/g, '/').replace(/\/$/, '')}`.replace(
          /:(\w+)/g,
          '{$1}',
        );
      });
  };
  // Д-100: комментарии к новостям — отдельный контроллер того же публичного API.
  const routes = [...routesOf(ExtController), ...routesOf(ExtCommentsController)].sort();
  const spec = buildOpenApi('https://cc.example') as { paths: Record<string, Record<string, unknown>> };
  const documented = Object.entries(spec.paths)
    .flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m} ${p}`))
    .sort();

  it('маршруты совпадают с описанием', () => {
    expect(routes.length).toBeGreaterThan(8);
    expect(documented).toEqual(routes);
  });

  it('документ — OpenAPI 3.1 с webhooks и схемой ключа', () => {
    const s = spec as unknown as Record<string, unknown>;
    expect(s.openapi).toBe('3.1.0');
    expect(Object.keys(s.webhooks as object)).toContain('botTurn');
    expect(JSON.stringify(s)).not.toContain('#/components/schemas/Unknown');
  });
});
