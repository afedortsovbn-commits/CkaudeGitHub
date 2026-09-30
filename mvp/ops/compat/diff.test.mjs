// Unit-тесты сравнения контрактов: node --test ops/compat/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareShape, compareSnapshots } from './diff.mjs';
import { fromJsonSchema as fromJs, union } from './snapshot.mjs';

const S = { t: 'string' };
const N = { t: 'number' };
const obj = (props, extra) => ({ t: 'object', props, ...(extra ? { extra } : {}) });
const req = (s) => ({ opt: false, s });
const opt = (s) => ({ opt: true, s });
const run = (a, b) => {
  const out = { errors: [], warnings: [] };
  compareShape(a, b, 'x', out);
  return out;
};

test('новое необязательное поле — совместимо', () => {
  assert.deepEqual(run(obj({ a: req(S) }), obj({ a: req(S), b: opt(N) })), { errors: [], warnings: [] });
});

test('новое обязательное, удалённое поле, смена обязательности и типа — ошибки', () => {
  assert.match(run(obj({ a: req(S) }), obj({ a: req(S), b: req(N) })).errors[0], /новое обязательное/);
  assert.match(run(obj({ a: req(S), b: opt(N) }), obj({ a: req(S) })).errors[0], /поле удалено/);
  assert.match(run(obj({ a: opt(S) }), obj({ a: req(S) })).errors[0], /стало обязательным/);
  assert.match(run(obj({ a: req(S) }), obj({ a: opt(S) })).errors[0], /стало необязательным/);
  assert.match(run(obj({ a: req(S) }), obj({ a: req(N) })).errors[0], /тип изменён/);
});

test('поле объекта с произвольными полями можно не описывать', () => {
  assert.deepEqual(run(obj({ a: req(S) }, { t: 'unknown' }), obj({}, { t: 'unknown' })).errors, []);
});

test('перечисления: удаление — ошибка, добавление — предупреждение, расширение до string — предупреждение', () => {
  const e = (...v) => ({ t: 'enum', values: v });
  assert.match(run(e('a', 'b'), e('a')).errors[0], /удалены значения "b"/);
  const w = run(e('a'), e('a', 'c'));
  assert.equal(w.errors.length, 0);
  assert.match(w.warnings[0], /добавлены значения "c"/);
  assert.equal(run(e('a', 'b'), S).errors.length, 0);
});

test('константный список сравнивается как набор', () => {
  const t = (...v) => ({ t: 'tuple', of: v.map((x) => ({ t: 'lit', v: x })) });
  assert.equal(run(t('a', 'b'), t('b', 'a', 'c')).errors.length, 0);
  assert.equal(run(t('a', 'b'), t('a')).errors.length, 1);
});

test('объединение с дискриминантом: варианты сопоставляются по тегу', () => {
  const v = (op, extra = {}) => obj({ op: req({ t: 'lit', v: op }), ...extra });
  const a = union([v('hold'), v('hangup')]);
  assert.equal(run(a, union([v('hold', { reason: opt(S) }), v('hangup'), v('park')])).errors.length, 0);
  assert.match(run(a, union([v('hold')])).errors[0], /удалён вариант op="hangup"/);
  assert.match(run(a, union([v('hold', { reason: req(S) }), v('hangup')])).errors[0], /новое обязательное/);
});

test('nullable: string → string|null — предупреждение, не ошибка', () => {
  const r = run(S, union([S, { t: 'null' }]));
  assert.equal(r.errors.length, 0);
  assert.equal(r.warnings.length, 1);
});

test('OpenAPI: удалённая операция и новый обязательный параметр — ошибки, allow.json снимает ошибку', () => {
  const op = (params) => ({ params, responses: { 200: obj({ id: req(S) }) } });
  const base = {
    types: {},
    values: {},
    openapi: { operations: { 'GET /a': op({}), 'GET /b': op({}) }, webhooks: {}, schemas: {} },
  };
  const next = {
    types: {},
    values: {},
    openapi: { operations: { 'GET /a': op({ 'query:x': req(S) }) }, webhooks: {}, schemas: {} },
  };
  const r = compareSnapshots(base, next);
  assert.equal(r.errors.length, 2);
  const r2 = compareSnapshots(base, next, [{ path: 'openapi GET /b', reason: 'тест' }]);
  assert.equal(r2.errors.length, 1);
  assert.equal(r2.allowed.length, 1);
});

test('JSON Schema приводится к форме', () => {
  assert.deepEqual(
    fromJs({
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'string' }, b: { type: ['integer', 'null'] } },
    }),
    obj({ a: req(S), b: opt(union([N, { t: 'null' }])) }),
  );
  assert.deepEqual(fromJs({ type: 'string', enum: ['x', 'y'] }), { t: 'enum', values: ['x', 'y'] });
});
