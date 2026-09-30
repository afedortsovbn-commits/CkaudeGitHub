// Сравнение снимков контрактов (ops/compat/snapshot.mjs): что сломает совместную работу версий N и N+1.
// Во время поэтапного обновления старые и новые экземпляры обмениваются данными в обе стороны (события,
// команды, REST), поэтому допустимы только аддитивные изменения (02-архитектура 6.2 п.7):
//   ошибка — удалён экспорт/поле/операция/значение перечисления, изменён тип, поле стало обязательным или
//            необязательным, появилось новое обязательное поле или обязательный параметр;
//   предупреждение — расширено перечисление/объединение (старый потребитель может не знать нового значения:
//            обрабатывать его как «неизвестное», новая функциональность — за фиче-флагом).
// Намеренное несовместимое изменение оформляется новым типом (`….v2`) с периодом двойной публикации,
// а исключение — записью в ops/compat/allow.json с причиной (путь из отчёта).

const key = (s) => JSON.stringify(s);

/** Ключ, по которому сопоставляются варианты объединения объектов (дискриминант). */
function discriminant(members) {
  if (!members.length || !members.every((m) => m.t === 'object')) return null;
  const candidates = Object.keys(members[0].props).filter((k) =>
    members.every((m) => m.props[k] && m.props[k].s.t === 'lit' && !m.props[k].opt),
  );
  const k = candidates.find((c) => new Set(members.map((m) => m.props[c].s.v)).size === members.length);
  return k ?? null;
}

export function compareShape(a, b, path, out) {
  if (key(a) === key(b)) return;
  if (a.t === 'unknown' || a.t === 'param' || a.t === 'cycle') return; // старый контракт ничего не обещал
  if (a.t === 'ref' && b.t === 'ref') {
    if (a.name !== b.name) out.errors.push(`${path}: тип изменён (${a.name} → ${b.name})`);
    return;
  }
  if (a.t === 'enum' || a.t === 'lit') {
    const av = a.t === 'enum' ? a.values : [a.v];
    if (b.t === 'enum' || b.t === 'lit') {
      const bv = b.t === 'enum' ? b.values : [b.v];
      const removed = av.filter((v) => !bv.includes(v));
      const added = bv.filter((v) => !av.includes(v));
      if (removed.length)
        out.errors.push(`${path}: удалены значения ${removed.map((v) => key(v)).join(', ')}`);
      if (added.length)
        out.warnings.push(`${path}: добавлены значения ${added.map((v) => key(v)).join(', ')}`);
      return;
    }
    const base = typeof av[0] === 'number' ? 'number' : typeof av[0] === 'boolean' ? 'boolean' : 'string';
    if (b.t === base) {
      out.warnings.push(`${path}: набор значений расширен до ${base}`);
      return;
    }
    if (b.t === 'union' && b.of.some((m) => m.t === base || (m.t === 'lit' && av.includes(m.v)))) {
      out.warnings.push(`${path}: тип расширен (${key(b).slice(0, 80)})`);
      return;
    }
  }
  if (a.t === 'union' || b.t === 'union') {
    const am = a.t === 'union' ? a.of : [a];
    const bm = b.t === 'union' ? b.of : [b];
    const d = discriminant(am) && discriminant(am) === discriminant(bm) ? discriminant(am) : null;
    if (d) {
      const bByTag = new Map(bm.map((m) => [key(m.props[d].s.v), m]));
      for (const m of am) {
        const tag = key(m.props[d].s.v);
        const other = bByTag.get(tag);
        if (!other) out.errors.push(`${path}: удалён вариант ${d}=${tag}`);
        else compareShape(m, other, `${path}[${d}=${tag}]`, out);
      }
      for (const m of bm) {
        if (!am.some((x) => key(x.props[d].s.v) === key(m.props[d].s.v))) {
          out.warnings.push(`${path}: добавлен вариант ${d}=${key(m.props[d].s.v)}`);
        }
      }
      return;
    }
    const bKeys = new Set(bm.map(key));
    const aKeys = new Set(am.map(key));
    const removed = am.filter((m) => !bKeys.has(key(m)));
    // Вариант, изменившийся внутри (объект с новыми необязательными полями), сравниваем с парным по виду.
    for (const m of removed) {
      const peers = bm.filter((x) => x.t === m.t && !aKeys.has(key(x)));
      if (peers.length === 1) compareShape(m, peers[0], `${path}|${m.t}`, out);
      else out.errors.push(`${path}: удалён вариант ${key(m).slice(0, 100)}`);
    }
    const matched = new Set(
      removed.map((m) => bm.find((x) => x.t === m.t && !aKeys.has(key(x)))).filter(Boolean),
    );
    for (const m of bm) {
      if (!aKeys.has(key(m)) && !matched.has(m))
        out.warnings.push(`${path}: добавлен вариант ${key(m).slice(0, 100)}`);
    }
    return;
  }
  if (a.t !== b.t) {
    out.errors.push(`${path}: тип изменён (${a.t} → ${b.t})`);
    return;
  }
  switch (a.t) {
    case 'array':
      compareShape(a.of, b.of, `${path}[]`, out);
      return;
    case 'tuple':
      // Константные списки (`[...] as const`: каналы, виды отчётов) сравниваются как наборы значений.
      if ([...a.of, ...b.of].every((x) => x.t === 'lit')) {
        compareShape(
          { t: 'enum', values: a.of.map((x) => x.v) },
          { t: 'enum', values: b.of.map((x) => x.v) },
          path,
          out,
        );
      } else if (a.of.length !== b.of.length) out.errors.push(`${path}: изменена длина кортежа`);
      else a.of.forEach((x, i) => compareShape(x, b.of[i], `${path}[${i}]`, out));
      return;
    case 'zod':
      compareShape(a.out, b.out, path, out);
      return;
    case 'object': {
      for (const [k, p] of Object.entries(a.props)) {
        const q = b.props[k];
        if (!q) {
          if (!b.extra) out.errors.push(`${path}.${k}: поле удалено`);
          continue;
        }
        if (!p.opt && q.opt) out.errors.push(`${path}.${k}: поле стало необязательным`);
        if (p.opt && !q.opt) out.errors.push(`${path}.${k}: поле стало обязательным`);
        compareShape(p.s, q.s, `${path}.${k}`, out);
      }
      for (const [k, q] of Object.entries(b.props)) {
        if (!a.props[k] && !q.opt) out.errors.push(`${path}.${k}: новое обязательное поле`);
      }
      if (a.extra && !b.extra) out.errors.push(`${path}: убраны произвольные поля (index signature)`);
      else if (a.extra && b.extra) compareShape(a.extra, b.extra, `${path}[*]`, out);
      return;
    }
    default:
      out.errors.push(`${path}: изменено (${key(a).slice(0, 60)} → ${key(b).slice(0, 60)})`);
  }
}

function compareOperation(a, b, path, out) {
  for (const [k, p] of Object.entries(a.params)) {
    const q = b.params[k];
    if (!q) out.errors.push(`${path} параметр ${k}: удалён`);
    else {
      if (p.opt && !q.opt) out.errors.push(`${path} параметр ${k}: стал обязательным`);
      compareShape(p.s, q.s, `${path} параметр ${k}`, out);
    }
  }
  for (const [k, q] of Object.entries(b.params)) {
    if (!a.params[k] && !q.opt) out.errors.push(`${path} параметр ${k}: новый обязательный`);
  }
  if (a.body && b.body) compareShape(a.body, b.body, `${path} тело`, out);
  else if (!a.body && b.body && b.bodyRequired)
    out.errors.push(`${path}: появилось обязательное тело запроса`);
  for (const [code, s] of Object.entries(a.responses)) {
    if (!b.responses[code]) out.errors.push(`${path} ответ ${code}: удалён`);
    else compareShape(s, b.responses[code], `${path} ответ ${code}`, out);
  }
}

/** Сравнивает снимки; возвращает {errors, warnings, added}. */
export function compareSnapshots(base, next, allow = []) {
  const out = { errors: [], warnings: [], added: [] };
  for (const section of ['types', 'values']) {
    for (const [name, s] of Object.entries(base[section] ?? {})) {
      const n = next[section]?.[name];
      if (!n) out.errors.push(`${section}.${name}: экспорт удалён`);
      else compareShape(s, n, `${section}.${name}`, out);
    }
    for (const name of Object.keys(next[section] ?? {})) {
      if (!base[section]?.[name]) out.added.push(`${section}.${name}`);
    }
  }
  if (base.openapi && next.openapi) {
    for (const group of ['operations', 'webhooks']) {
      for (const [name, op] of Object.entries(base.openapi[group])) {
        const n = next.openapi[group][name];
        if (!n) out.errors.push(`openapi ${name}: операция удалена`);
        else compareOperation(op, n, `openapi ${name}`, out);
      }
      for (const name of Object.keys(next.openapi[group])) {
        if (!base.openapi[group][name]) out.added.push(`openapi ${name}`);
      }
    }
    for (const [name, s] of Object.entries(base.openapi.schemas)) {
      const n = next.openapi.schemas[name];
      if (!n) out.errors.push(`openapi схема ${name}: удалена`);
      else compareShape(s, n, `openapi схема ${name}`, out);
    }
  } else if (base.openapi && !next.openapi) {
    out.errors.push('openapi: описание публичного API удалено');
  }
  // Разрешённые исключения (ops/compat/allow.json): [{ "path": "<начало строки отчёта>", "reason": "…" }].
  const allowed = [];
  out.errors = out.errors.filter((e) => {
    const a = allow.find((x) => e.startsWith(x.path));
    if (a) allowed.push(`${e} — разрешено: ${a.reason}`);
    return !a;
  });
  out.allowed = allowed;
  return out;
}
