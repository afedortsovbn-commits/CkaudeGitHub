/**
 * Области видимости (M-ORG-07, 02-архитектура 5.1).
 * Правило = предприятия × подразделения × темы; null в измерении = «все».
 * Правила сотрудника объединяются по ИЛИ. Тема покрывает своё поддерево (сравнение с path строки).
 * Единая функция для всех запросов списков, поиска, карточек и отчётов.
 */
export interface ScopeRule {
  enterpriseIds: string[] | null;
  departmentIds: string[] | null;
  topicIds: string[] | null;
}

export interface ScopeSubject {
  /** Право scope.all — видит всё. */
  all: boolean;
  rules: ScopeRule[];
}

/** SQL-выражения столбцов проверяемой строки; отсутствующее измерение не ограничивает. */
export interface ScopeColumns {
  enterprise?: string;
  department?: string;
  /** Массив uuid[] — путь темы строки (корень…тема). */
  topicPath?: string;
}

export interface SqlFragment {
  sql: string;
  params: unknown[];
}

/**
 * Строит условие WHERE. startIndex — номер первого параметра ($n), чтобы встроить в чужой запрос.
 */
export function scopeFilter(subject: ScopeSubject, cols: ScopeColumns, startIndex = 1): SqlFragment {
  if (subject.all) return { sql: 'TRUE', params: [] };
  if (subject.rules.length === 0) return { sql: 'FALSE', params: [] };
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${startIndex + params.length - 1}`;
  };
  const ors = subject.rules.map((r) => {
    const ands: string[] = [];
    if (r.enterpriseIds && cols.enterprise)
      ands.push(`${cols.enterprise} = ANY(${p(r.enterpriseIds)}::uuid[])`);
    if (r.departmentIds && cols.department)
      ands.push(`${cols.department} = ANY(${p(r.departmentIds)}::uuid[])`);
    if (r.topicIds && cols.topicPath) ands.push(`${cols.topicPath} && ${p(r.topicIds)}::uuid[]`);
    return ands.length ? `(${ands.join(' AND ')})` : 'TRUE';
  });
  return { sql: `(${ors.join(' OR ')})`, params };
}

/** Проверка в памяти (для событий realtime и уже загруженных объектов) — та же семантика, что у SQL. */
export function inScope(
  subject: ScopeSubject,
  row: { enterpriseId?: string | null; departmentId?: string | null; topicPath?: string[] | null },
): boolean {
  if (subject.all) return true;
  return subject.rules.some(
    (r) =>
      (!r.enterpriseIds ||
        row.enterpriseId === undefined ||
        (!!row.enterpriseId && r.enterpriseIds.includes(row.enterpriseId))) &&
      (!r.departmentIds ||
        row.departmentId === undefined ||
        (!!row.departmentId && r.departmentIds.includes(row.departmentId))) &&
      (!r.topicIds ||
        row.topicPath === undefined ||
        (!!row.topicPath && row.topicPath.some((t) => r.topicIds!.includes(t)))),
  );
}
