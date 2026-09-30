-- Ф10: упрощённая аналитика (M-REP-01..03). Отчёты считаются по журналу `event`: здесь — индексы для выборок
-- по обращению/тикету и времени, функция извлечения пути темы из jsonb, право «Отчёты» и пороги панели
-- супервизора. Только expand-изменения.
SET lock_timeout = '5s';

-- Путь темы (jsonb-массив uuid из события) → uuid[] для предиката области видимости (scopeFilter).
CREATE OR REPLACE FUNCTION cc_uuid_array(j jsonb) RETURNS uuid[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(array_agg(x::uuid), '{}'::uuid[])
    FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(j) = 'array' THEN j ELSE '[]'::jsonb END) AS x
$$;

-- Все события одного обращения / тикета по времени (история статусов, эпизоды ожидания и обработки).
CREATE INDEX IF NOT EXISTS event_conversation_idx ON event ((data ->> 'conversationId'), occurred_at)
  WHERE data ? 'conversationId';
CREATE INDEX IF NOT EXISTS event_ticket_idx ON event ((data ->> 'ticketId'), occurred_at)
  WHERE data ? 'ticketId';
-- Выборка за период по всем типам.
CREATE INDEX IF NOT EXISTS event_time_idx ON event (occurred_at);

-- Право «Отчёты» (reports.view): администратор и супервизор.
UPDATE role SET permissions = array_append(permissions, 'reports.view')
 WHERE code IN ('admin', 'supervisor') AND NOT ('reports.view' = ANY(permissions));

-- Пороги панели супервизора (M-REP-02) и параметры расчёта отчётов; меняются в «Настройках» без перезапуска.
INSERT INTO system_setting (key, value) VALUES
  ('supervisor.thresholds',
   '{"waitWarnS": 60, "waitCritS": 180, "queueWarn": 5, "queueCrit": 15, "breakWarnS": 900, "slTargetPct": 80}'),
  -- SL: ответ в пределах N секунд (голос / текстовые каналы).
  ('report.sl_voice_s', '20'),
  ('report.sl_text_s', '60'),
  -- Сброс раньше N секунд ожидания не считается пропущенным (короткий сброс).
  ('report.short_abandon_s', '5'),
  -- Порог «первый ответ в чате вовремя», секунд.
  ('report.first_response_s', '120')
ON CONFLICT (key) DO NOTHING;
