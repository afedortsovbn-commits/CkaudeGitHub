import { api } from './i18n/api';
import { widget } from './i18n/widget';

/** Строки интерфейса виджета. Русский — основной язык; структура позволяет добавить другие (M-NFR-08). */
const ru = {
  // Разделы страниц и компонентов (Ф12b): lib/i18n/<раздел>.ts.
  api,
  widget,
};

export const t = ru;
