-- Ф13 (находка zero-downtime): предыдущий refresh-токен сессии ещё 2 минуты после ротации принимается — ответ с новым
-- токеном мог не дойти до браузера (смена сети, обрыв соединения при замене экземпляров), и оператора выбрасывало на
-- вход. Только expand-изменения: старая версия api эти поля не читает и не заполняет.
SET lock_timeout = '5s';

ALTER TABLE auth_session ADD COLUMN IF NOT EXISTS prev_refresh_hash text;
ALTER TABLE auth_session ADD COLUMN IF NOT EXISTS rotated_at timestamptz;
CREATE INDEX IF NOT EXISTS auth_session_prev_refresh_idx ON auth_session (prev_refresh_hash)
  WHERE prev_refresh_hash IS NOT NULL;
