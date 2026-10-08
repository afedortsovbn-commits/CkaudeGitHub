-- Производственный календарь (доработки 08.10.2026). По умолчанию дни считаются по законодательству Республики
-- Беларусь (packages/domain/src/work-calendar.ts); здесь хранятся только корректировки дней: переносы рабочих
-- дней, дополнительные выходные и т. п. Норма часов и потребность графика работы берутся из календаря.
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS work_calendar_day (
  on_date    date PRIMARY KEY,
  kind       text        NOT NULL CHECK (kind IN ('work', 'short', 'off', 'holiday')),
  note       text,
  updated_by uuid REFERENCES app_user (id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
