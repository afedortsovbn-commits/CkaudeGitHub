-- Д-017 «Распределение по загрузке» (10.10.2026): срок ответа неспешных обращений (отзывы, почта) для старения и
-- контроля просрочки; число продлений постобработки «+2 мин» (видно супервизору). Только expand-изменения.
SET lock_timeout = '5s';
ALTER TABLE conversation ADD COLUMN IF NOT EXISTS due_at timestamptz;
CREATE INDEX IF NOT EXISTS conversation_queued_due_idx ON conversation (status, due_at) WHERE status = 'queued';
ALTER TABLE agent_status ADD COLUMN IF NOT EXISTS wrap_up_extends integer NOT NULL DEFAULT 0;
