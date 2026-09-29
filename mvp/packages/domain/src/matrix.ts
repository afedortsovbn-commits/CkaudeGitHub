/**
 * Подстановка ответственных, кураторов и срока по умолчанию (M-ORG-03, M-ORG-05, M-TKT-01).
 * Чистые функции — логика наследования покрыта unit-тестами.
 */
export type Kind = 'responsible' | 'curator';

export interface MatrixRow {
  topicId: string;
  userId: string;
  kind: Kind;
}

export interface Defaults {
  responsibles: string[];
  curators: string[];
  /** Тема, на уровне которой найдены назначения (для пояснения в интерфейсе). */
  responsibleFromTopicId: string | null;
  curatorFromTopicId: string | null;
}

/**
 * @param topicPath путь темы от корня к самой теме: [корень, …, тема]
 * @param rows активные строки матрицы для «подразделения на предприятии» по темам из topicPath
 *             (только активные сотрудники)
 * Для каждого вида отдельно берётся самый точный уровень, где есть назначения: подтема → тема → корень.
 */
export function resolveDefaults(topicPath: string[], rows: MatrixRow[]): Defaults {
  const pick = (kind: Kind) => {
    for (let i = topicPath.length - 1; i >= 0; i--) {
      const t = topicPath[i]!;
      const users = rows.filter((r) => r.kind === kind && r.topicId === t).map((r) => r.userId);
      if (users.length) return { users: [...new Set(users)], from: t };
    }
    return { users: [] as string[], from: null };
  };
  const r = pick('responsible');
  const c = pick('curator');
  return {
    responsibles: r.users,
    curators: c.users,
    responsibleFromTopicId: r.from,
    curatorFromTopicId: c.from,
  };
}

/**
 * Срок ответа по умолчанию: ближайший заданный срок вверх по дереву тем, иначе глобальный (15 дней).
 * @param pathDays сроки тем по пути [корень, …, тема]; null — не задан
 */
export function resolveResponseDays(pathDays: (number | null)[], globalDays: number): number {
  for (let i = pathDays.length - 1; i >= 0; i--) {
    const d = pathDays[i];
    if (d != null) return d;
  }
  return globalDays;
}

/** Срок ответа — конец дня (23:59:59) через N календарных дней в часовом поясе системы (M-TKT-03). */
export function dueDate(from: Date, days: number, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const local = fmt.format(from); // YYYY-MM-DD в поясе системы
  const d = new Date(`${local}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
