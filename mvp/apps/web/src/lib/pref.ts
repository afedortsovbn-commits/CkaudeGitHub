/**
 * Удобства этого браузера (свёрнуто ли меню, закрытые группы, раскрытые блоки настроек) — не данные: ошибки
 * хранилища не мешают.
 */
export const pref = {
  get<T>(k: string, def: T): T {
    try {
      const v = localStorage.getItem(k);
      return v === null ? def : (JSON.parse(v) as T);
    } catch {
      return def;
    }
  },
  set(k: string, v: unknown): void {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* приватный режим и т.п. */
    }
  },
};
