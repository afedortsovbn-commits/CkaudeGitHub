-- Ф14 (указания заказчика 01.10): позиция в очереди (M-TEL-07, опция очереди), суфлирование, вмешательство и
-- перехват (M-TEL-10), подсказки оператору в чате. Тайм-аут молчания в боте (M-AUTO-04) хранится в состоянии шага
-- бота (conversation.bot_state) и изменений схемы не требует. Только expand-изменения.
SET lock_timeout = '5s';

-- ---------- M-TEL-07: позиция в очереди — опция очереди, по умолчанию выключена ----------
-- Звонящему сообщается позиция («Вы второй в очереди») при постановке и затем раз в announce_position_every_s, пока
-- он ждёт оператора; в автоответе «в очереди» текстовых каналов доступна переменная {{позиция}}.
ALTER TABLE queue ADD COLUMN IF NOT EXISTS announce_position boolean NOT NULL DEFAULT false;
ALTER TABLE queue ADD COLUMN IF NOT EXISTS announce_position_every_s integer NOT NULL DEFAULT 60
  CHECK (announce_position_every_s BETWEEN 15 AND 3600);
-- Когда звонящему последний раз сообщили позицию и идущее проигрывание (переживает смену активного call-control).
ALTER TABLE call ADD COLUMN IF NOT EXISTS position_announced_at timestamptz;
ALTER TABLE call ADD COLUMN IF NOT EXISTS position_playback text;

-- ---------- M-TEL-10: режим подключения супервизора к разговору ----------
-- listen — прослушивание, whisper — суфлирование (слышит только оператор), barge — вмешательство (слышат оба).
-- Режим эфемерен, как прослушивание: при смене активного call-control подключение завершается и отметка снимается;
-- в строке вызова — чтобы оператор видел плашку «Супервизор подсказывает/в разговоре» (событие conversation.call).
ALTER TABLE call ADD COLUMN IF NOT EXISTS supervisor_user_id uuid REFERENCES app_user (id);
ALTER TABLE call ADD COLUMN IF NOT EXISTS supervisor_mode text
  CHECK (supervisor_mode IS NULL OR supervisor_mode IN ('listen', 'whisper', 'barge'));

-- ---------- Права супервизора (Ф14): у ролей «Супервизор» и «Администратор» по умолчанию ----------
UPDATE role SET permissions = array_append(permissions, 'calls.whisper')
 WHERE code IN ('admin', 'supervisor') AND NOT ('calls.whisper' = ANY(permissions));
UPDATE role SET permissions = array_append(permissions, 'calls.barge')
 WHERE code IN ('admin', 'supervisor') AND NOT ('calls.barge' = ANY(permissions));
UPDATE role SET permissions = array_append(permissions, 'conversations.takeover')
 WHERE code IN ('admin', 'supervisor') AND NOT ('conversations.takeover' = ANY(permissions));
UPDATE role SET permissions = array_append(permissions, 'conversations.hint')
 WHERE code IN ('admin', 'supervisor') AND NOT ('conversations.hint' = ANY(permissions));
