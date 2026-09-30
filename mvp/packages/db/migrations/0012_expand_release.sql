-- Ф11: выпуск релизов без простоя — журнал выпусков, фиче-флаги по умолчанию, вывод coturn из выдачи ICE.
-- Только expand-изменения.
SET lock_timeout = '5s';

-- Журнал выпусков (ops/release.sh): кто, когда, что обновлено, итог и отчёт.
CREATE TABLE IF NOT EXISTS release_log (
  id           uuid PRIMARY KEY,
  tag          text        NOT NULL,
  prev_tag     text,
  status       text        NOT NULL CHECK (status IN ('started', 'succeeded', 'failed', 'rolled_back')),
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  report       jsonb       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS release_log_started_idx ON release_log (started_at DESC);

-- Автообновление интерфейса оператора вне звонка (M-OP-11) — включено; администратор может выключить.
INSERT INTO feature_flag (key, enabled, description) VALUES
  ('web.auto_reload', true, 'Автоматическое обновление интерфейса оператора до новой версии вне звонка')
ON CONFLICT (key) DO NOTHING;

-- Экземпляры coturn, выведенные из выдачи ICE-серверов на время обновления (ops/update-media.sh coturn-N).
INSERT INTO system_setting (key, value) VALUES ('telephony.turn_disabled', '[]') ON CONFLICT (key) DO NOTHING;
