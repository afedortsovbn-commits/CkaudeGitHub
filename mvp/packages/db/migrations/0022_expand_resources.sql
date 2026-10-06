-- Контроль ресурсов сервера и сроки хранения (доработки 06.10.2026).
-- Записи разговоров храним 5 лет: прежнее значение по умолчанию (180 дней) заменяется, заданное вручную — нет.
SET lock_timeout = '5s';
UPDATE system_setting SET value = '1825', updated_at = now()
 WHERE key = 'recording.retention_days' AND value = '180'::jsonb;
INSERT INTO system_setting (key, value) VALUES ('recording.retention_days', '1825') ON CONFLICT (key) DO NOTHING;
-- Пороги контроля ресурсов, % занятого: «внимание» и «критично» (уведомления администраторам и супервизорам).
INSERT INTO system_setting (key, value) VALUES ('resource.warn_pct', '80'), ('resource.crit_pct', '90')
ON CONFLICT (key) DO NOTHING;
