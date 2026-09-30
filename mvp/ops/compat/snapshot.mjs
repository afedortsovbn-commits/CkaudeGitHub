// Снимок контрактов для проверки совместимости N/N+1 (02-архитектура 6.2 п.7, 6.6 п.1; Ф11).
// Источник — исходники `packages/contracts/src` и описание публичного API `apps/api/src/ext/openapi.ts`
// из рабочего каталога или из любой git-ревизии (предыдущий релиз), поэтому сборка не нужна.
//  - types:  экспортируемые типы и интерфейсы (в т.ч. выведенные из zod `z.infer`) — структура через TypeScript;
//  - values: экспортируемые константы (каталоги событий, прав, статусов) и zod-схемы (тип `_output`);
//  - openapi: операции, параметры, тела запросов, ответы 2xx, схемы компонентов, webhooks.
// Структура приводится к общему виду «форма»: {t: string|number|boolean|lit|enum|array|tuple|object|union|ref|…}.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';

export const MVP = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const CONTRACTS_SRC = 'packages/contracts/src';
const OPENAPI_SRC = 'apps/api/src/ext/openapi.ts';

/** Источник файлов: рабочий каталог (ref не задан) или git-ревизия. Пути — от каталога mvp. */
export function sourceOf(ref) {
  if (!ref) {
    return {
      label: 'рабочий каталог',
      list: (dir) => (existsSync(join(MVP, dir)) ? readdirSync(join(MVP, dir)) : []),
      read: (path) => (existsSync(join(MVP, path)) ? readFileSync(join(MVP, path), 'utf8') : null),
    };
  }
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: MVP, encoding: 'utf8' }).trim();
  const prefix = relative(root, MVP);
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1 << 26,
    });
  execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: root, stdio: 'pipe' });
  return {
    label: ref,
    list: (dir) => {
      try {
        return git('ls-tree', '--name-only', `${ref}:${join(prefix, dir)}`)
          .split('\n')
          .filter(Boolean);
      } catch {
        return [];
      }
    },
    read: (path) => {
      try {
        return git('show', `${ref}:${join(prefix, path)}`);
      } catch {
        return null;
      }
    },
  };
}

const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
const key = (s) => JSON.stringify(s);

// ---------------------------------------------------------------- TypeScript → форма
function contractFiles(src) {
  return src
    .list(CONTRACTS_SRC)
    .filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts') && !n.endsWith('.d.ts'))
    .map((n) => [join(MVP, CONTRACTS_SRC, n), src.read(join(CONTRACTS_SRC, n))]);
}

function snapshotTypes(src) {
  const files = new Map(contractFiles(src));
  const index = join(MVP, CONTRACTS_SRC, 'index.ts');
  if (!files.has(index)) return { types: {}, values: {} };
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.Node16,
    moduleResolution: ts.ModuleResolutionKind.Node16,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  };
  const host = ts.createCompilerHost(options);
  const inSrc = (f) => f.startsWith(join(MVP, CONTRACTS_SRC) + '/');
  const origGet = host.getSourceFile.bind(host);
  host.fileExists = ((orig) => (f) => (inSrc(f) ? files.has(f) : orig(f)))(host.fileExists.bind(host));
  host.readFile = ((orig) => (f) => (inSrc(f) ? (files.get(f) ?? undefined) : orig(f)))(
    host.readFile.bind(host),
  );
  host.getSourceFile = (f, lang, onError, create) =>
    inSrc(f)
      ? files.has(f)
        ? ts.createSourceFile(f, files.get(f), lang, true)
        : undefined
      : origGet(f, lang, onError, create);
  const program = ts.createProgram([index], options, host);
  const checker = program.getTypeChecker();
  const mod = checker.getSymbolAtLocation(program.getSourceFile(index));
  const exports = checker.getExportsOfModule(mod);
  const exportedTypeNames = new Set(
    exports
      .filter((s) => (s.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias)) !== 0)
      .map((s) => s.name),
  );

  const fromContracts = (sym) =>
    (sym?.declarations ?? []).some((d) => inSrc(d.getSourceFile().fileName)) &&
    exportedTypeNames.has(sym.name);

  function ser(type, depth, seen) {
    const f = type.flags;
    if (f & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return { t: 'unknown' };
    if (f & ts.TypeFlags.Never) return { t: 'never' };
    if (f & ts.TypeFlags.StringLiteral) return { t: 'lit', v: type.value };
    if (f & ts.TypeFlags.NumberLiteral) return { t: 'lit', v: type.value };
    if (f & ts.TypeFlags.BooleanLiteral) return { t: 'lit', v: checker.typeToString(type) === 'true' };
    if (f & ts.TypeFlags.Boolean) return { t: 'boolean' };
    if (f & ts.TypeFlags.String) return { t: 'string' };
    if (f & ts.TypeFlags.Number) return { t: 'number' };
    if (f & ts.TypeFlags.BigInt) return { t: 'bigint' };
    if (f & ts.TypeFlags.Null) return { t: 'null' };
    if (f & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) return { t: 'undefined' };
    if (f & ts.TypeFlags.TypeParameter) return { t: 'param', name: type.symbol?.name ?? '?' };
    if (f & ts.TypeFlags.TemplateLiteral) return { t: 'string' };
    if (f & ts.TypeFlags.Union) return union(type.types.map((m) => ser(m, depth, seen)));
    if (depth > 0) {
      const named = type.aliasSymbol && fromContracts(type.aliasSymbol) ? type.aliasSymbol : null;
      const iface = !named && type.symbol && fromContracts(type.symbol) ? type.symbol : null;
      if (named || iface) return { t: 'ref', name: (named ?? iface).name };
    }
    if (type.symbol && !(type.symbol.declarations ?? []).some((d) => inSrc(d.getSourceFile().fileName))) {
      const n = type.symbol.name;
      if (n === 'Date' || n === 'Buffer' || n === 'Uint8Array') return { t: 'ext', name: n };
    }
    if (checker.isArrayType(type)) {
      return { t: 'array', of: ser(checker.getTypeArguments(type)[0], depth + 1, seen) };
    }
    if (checker.isTupleType(type)) {
      return { t: 'tuple', of: checker.getTypeArguments(type).map((a) => ser(a, depth + 1, seen)) };
    }
    if (f & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) {
      if (seen.has(type) || depth > 12) return { t: 'cycle' };
      const props = checker.getPropertiesOfType(type);
      if (!props.length && type.getCallSignatures().length) return { t: 'function' };
      seen = new Set(seen).add(type);
      const out = {};
      for (const p of props) {
        const decl = p.valueDeclaration ?? p.declarations?.[0];
        const pt = decl ? checker.getTypeOfSymbolAtLocation(p, decl) : checker.getTypeOfSymbol(p);
        const s = ser(pt, depth + 1, seen);
        if (s.t === 'function') continue;
        out[p.name] = { opt: (p.flags & ts.SymbolFlags.Optional) !== 0, s: stripUndefined(s) };
      }
      const idx = checker.getIndexInfosOfType(type);
      const extra = idx.length ? stripUndefined(ser(idx[0].type, depth + 1, seen)) : null;
      return { t: 'object', props: sortObj(out), ...(extra ? { extra } : {}) };
    }
    return { t: 'unknown', note: checker.typeToString(type) };
  }

  const types = {};
  const values = {};
  for (const sym of exports) {
    const target = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
    if (target.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias)) {
      types[sym.name] = ser(checker.getDeclaredTypeOfSymbol(target), 0, new Set());
    }
    if (target.flags & ts.SymbolFlags.Variable) {
      const decl = target.valueDeclaration;
      if (!decl || !inSrc(decl.getSourceFile().fileName)) continue;
      const vt = checker.getTypeOfSymbolAtLocation(target, decl);
      const output = vt.getProperty('_output');
      if (output) {
        values[sym.name] = {
          t: 'zod',
          out: ser(checker.getTypeOfSymbolAtLocation(output, decl), 0, new Set()),
        };
        continue;
      }
      if (vt.getCallSignatures().length) continue; // вспомогательные функции — код, не контракт
      values[sym.name] = ser(vt, 0, new Set());
    }
  }
  return { types: sortObj(types), values: sortObj(values) };
}

export function union(members) {
  const flat = [];
  for (const m of members) {
    if (m.t === 'union') flat.push(...m.of);
    else if (m.t === 'enum') flat.push(...m.values.map((v) => ({ t: 'lit', v })));
    else flat.push(m);
  }
  const uniq = [...new Map(flat.map((m) => [key(m), m])).values()];
  const bools = uniq.filter((m) => m.t === 'lit' && typeof m.v === 'boolean');
  const rest = bools.length === 2 ? [...uniq.filter((m) => !bools.includes(m)), { t: 'boolean' }] : uniq;
  if (rest.length === 1) return rest[0];
  if (rest.every((m) => m.t === 'lit')) return { t: 'enum', values: rest.map((m) => m.v).sort() };
  return { t: 'union', of: rest.sort((a, b) => (key(a) < key(b) ? -1 : 1)) };
}

function stripUndefined(s) {
  if (s.t !== 'union') return s;
  const of = s.of.filter((m) => m.t !== 'undefined');
  return of.length === s.of.length ? s : union(of);
}

// ---------------------------------------------------------------- OpenAPI
/** Транспилирует исходники ревизии во временный каталог рядом с пакетом contracts (там же разрешается zod). */
function buildOpenApi(src) {
  const openapi = src.read(OPENAPI_SRC);
  if (!openapi) return null;
  const tmp = join(MVP, 'packages/contracts/.compat-tmp', `${process.pid}-${Date.now()}`);
  try {
    const opts = { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true };
    for (const [file, code] of contractFiles(src)) {
      const out = join(tmp, 'contracts', relative(join(MVP, CONTRACTS_SRC), file).replace(/\.ts$/, '.js'));
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, ts.transpileModule(code, { compilerOptions: opts }).outputText);
    }
    const js = ts
      .transpileModule(openapi, { compilerOptions: opts })
      .outputText.replace(/require\("@cc\/contracts"\)/g, 'require("./contracts/index.js")');
    writeFileSync(join(tmp, 'openapi.js'), js);
    const req = createRequire(join(tmp, 'openapi.js'));
    return req('./openapi.js').buildOpenApi('https://compat.invalid');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** JSON Schema (OpenAPI 3.1) → форма. */
export function fromJsonSchema(s) {
  if (!s || typeof s !== 'object') return { t: 'unknown' };
  if (s.$ref) return { t: 'ref', name: s.$ref.split('/').at(-1) };
  if ('const' in s) return { t: 'lit', v: s.const };
  if (s.enum) return union(s.enum.map((v) => (v === null ? { t: 'null' } : { t: 'lit', v })));
  if (s.oneOf || s.anyOf) return union((s.oneOf ?? s.anyOf).map(fromJsonSchema));
  if (s.allOf) {
    const parts = s.allOf.map(fromJsonSchema);
    if (parts.length === 1) return parts[0];
    return { t: 'allOf', of: parts };
  }
  if (Array.isArray(s.type)) return union(s.type.map((t) => fromJsonSchema({ ...s, type: t })));
  switch (s.type) {
    case 'string':
      return { t: 'string' };
    case 'integer':
    case 'number':
      return { t: 'number' };
    case 'boolean':
      return { t: 'boolean' };
    case 'null':
      return { t: 'null' };
    case 'array':
      return { t: 'array', of: fromJsonSchema(s.items) };
    case 'object':
    case undefined: {
      if (!s.properties && !s.additionalProperties && s.type === undefined) return { t: 'unknown' };
      const req = new Set(s.required ?? []);
      const props = {};
      for (const [k, v] of Object.entries(s.properties ?? {}))
        props[k] = { opt: !req.has(k), s: fromJsonSchema(v) };
      const extra =
        s.additionalProperties && s.additionalProperties !== false
          ? s.additionalProperties === true
            ? { t: 'unknown' }
            : fromJsonSchema(s.additionalProperties)
          : null;
      return { t: 'object', props: sortObj(props), ...(extra ? { extra } : {}) };
    }
    default:
      return { t: 'unknown' };
  }
}

const METHODS = ['get', 'put', 'post', 'delete', 'patch'];
function operation(op) {
  const params = {};
  for (const p of op.parameters ?? []) {
    params[`${p.in}:${p.name}`] = { opt: !p.required, s: fromJsonSchema(p.schema) };
  }
  const body = op.requestBody?.content?.['application/json']?.schema;
  const responses = {};
  for (const [code, r] of Object.entries(op.responses ?? {})) {
    if (!/^2/.test(code)) continue;
    const sch = r.content?.['application/json']?.schema;
    responses[code] = sch ? fromJsonSchema(sch) : { t: 'empty' };
  }
  return {
    params: sortObj(params),
    ...(body ? { body: fromJsonSchema(body), bodyRequired: !!op.requestBody.required } : {}),
    responses: sortObj(responses),
  };
}

function snapshotOpenApi(doc) {
  if (!doc) return null;
  const ops = {};
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const m of METHODS) if (item[m]) ops[`${m.toUpperCase()} ${path}`] = operation(item[m]);
  }
  const webhooks = {};
  for (const [name, item] of Object.entries(doc.webhooks ?? {})) {
    for (const m of METHODS) if (item[m]) webhooks[name] = operation(item[m]);
  }
  const schemas = {};
  for (const [name, s] of Object.entries(doc.components?.schemas ?? {})) schemas[name] = fromJsonSchema(s);
  return { operations: sortObj(ops), webhooks: sortObj(webhooks), schemas: sortObj(schemas) };
}

/** Полный снимок ревизии (ref не задан — рабочий каталог). */
export function snapshot(ref) {
  const src = sourceOf(ref);
  return { source: src.label, ...snapshotTypes(src), openapi: snapshotOpenApi(buildOpenApi(src)) };
}
