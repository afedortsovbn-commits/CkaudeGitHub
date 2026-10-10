/** Кандидат на назначение обращения (02-архитектура, 7: `RoutingStrategy.select(candidates, item)`). */
export interface Candidate {
  userId: string;
  /** Активные обращения оператора (для ёмкости и least-load). */
  activeCount: number;
  /** Когда оператору в последний раз что-то назначали; null — никогда. */
  lastAssignedAt: string | null;
  /** Максимальный уровень навыка, связанного с темой обращения; 0 — навык не назначен/не требуется. */
  skillLevel: number;
  /** Свободная ёмкость в режиме «по загрузке» (Д-017), единиц из 100; null — режим не «по загрузке». */
  freeCapacity?: number | null;
}

export type RoutingStrategy = (candidates: Candidate[]) => Candidate | undefined;

const recencyRank = (c: Candidate): number => (c.lastAssignedAt ? Date.parse(c.lastAssignedAt) : -Infinity);

/** При равенстве основного критерия — выше навык, затем кто дольше свободен. */
function tieBreak(a: Candidate, b: Candidate): number {
  return b.skillLevel - a.skillLevel || recencyRank(a) - recencyRank(b);
}

/** «Дольше всех свободен» (M-RT-03): у кого раньше было последнее назначение (или не было вовсе). */
export const leastRecent: RoutingStrategy = (candidates) =>
  [...candidates].sort((a, b) => recencyRank(a) - recencyRank(b) || tieBreak(a, b))[0];

/** «Наименьшая загрузка» (M-RT-03): меньше активных обращений сейчас. */
export const leastLoad: RoutingStrategy = (candidates) =>
  [...candidates].sort((a, b) => a.activeCount - b.activeCount || tieBreak(a, b))[0];

/**
 * Режим «по загрузке» (Д-017, п.5), звонок: у кого меньше активных чатов; при равенстве — кто дольше без звонка
 * (`lastAssignedAt` здесь — `last_voice_at`), затем навык.
 */
export const loadVoice: RoutingStrategy = (candidates) =>
  [...candidates].sort(
    (a, b) => a.activeCount - b.activeCount || recencyRank(a) - recencyRank(b) || b.skillLevel - a.skillLevel,
  )[0];

/**
 * Режим «по загрузке», чат: у кого больше свободной ёмкости; при равенстве — кто дольше без текстовых обращений
 * (`lastAssignedAt` здесь — `last_text_at`), затем навык.
 */
export const loadChat: RoutingStrategy = (candidates) =>
  [...candidates].sort(
    (a, b) =>
      (b.freeCapacity ?? 0) - (a.freeCapacity ?? 0) ||
      recencyRank(a) - recencyRank(b) ||
      b.skillLevel - a.skillLevel,
  )[0];

export const STRATEGIES: Record<string, RoutingStrategy> = {
  least_recent: leastRecent,
  least_load: leastLoad,
};

export function pickCandidate(strategyName: string, candidates: Candidate[]): Candidate | undefined {
  if (!candidates.length) return undefined;
  const strategy = STRATEGIES[strategyName] ?? leastRecent;
  return strategy(candidates);
}
