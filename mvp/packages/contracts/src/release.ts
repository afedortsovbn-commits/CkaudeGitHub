/**
 * Выпуск релиза без простоя (Ф11, 02-архитектура 6.6–6.8).
 * `app.version` — после поэтапного обновления web: открытые вкладки показывают «Доступна новая версия» и
 * обновляются сами, когда у оператора нет звонка и неотправленного черновика (M-OP-11).
 */
export const APP_EVENTS = {
  version: 'app.version',
} as const;

export interface AppVersionEventData {
  /** Компонент, версия которого сменилась (сейчас только статика web). */
  component: 'web';
  version: string;
  [k: string]: unknown;
}

/**
 * Фиче-флаги: новая функциональность включается **после** обновления всех экземпляров (`ops/release.sh`,
 * FEATURE_FLAGS=…), поэтому старые экземпляры её не видят. Известные флаги и значения по умолчанию.
 */
export const FEATURE_FLAGS = {
  'web.auto_reload': 'Автоматическое обновление интерфейса оператора до новой версии вне звонка (M-OP-11)',
} as const;
export type FeatureFlagKey = keyof typeof FEATURE_FLAGS;

/** Настройка со списком экземпляров coturn, выведенных из выдачи ICE-серверов (обновление coturn, 02 — 6.5). */
export const TURN_DISABLED_SETTING = 'telephony.turn_disabled';

export interface TurnServerEntry {
  /** Имя экземпляра (как сервис compose: coturn-1, coturn-2). */
  name: string;
  url: string;
}

/**
 * Разбор TURN_URLS: `turn:a:3478,turn:a:3479` (имена по порядку — coturn-1, coturn-2, …) или с явными
 * именами `coturn-1=turn:a:3478,coturn-2=turn:a:3479`.
 */
export function parseTurnUrls(raw: string): TurnServerEntry[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s, i) => {
      const m = /^([A-Za-z0-9_.-]+)=(.+)$/.exec(s);
      return m ? { name: m[1]!, url: m[2]!.trim() } : { name: `coturn-${i + 1}`, url: s };
    });
}
