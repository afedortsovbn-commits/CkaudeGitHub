-- Ф12b: закрытие пробелов приёмки — обязательный тег при закрытии (опция очереди, M-CARD-06), ручное слияние
-- дублей клиентов (M-CARD-01). Только expand-изменения.
SET lock_timeout = '5s';

-- ---------- M-CARD-06: обязательный тег при закрытии — опция очереди ----------
-- Обращение очереди с отметкой нельзя закрыть (и передать на 2-ю линию) без хотя бы одного тега.
ALTER TABLE queue ADD COLUMN IF NOT EXISTS require_tag boolean NOT NULL DEFAULT false;

-- ---------- M-CARD-01: ручное слияние дублей клиентов ----------
-- Дубль помечается merged_into_id (столбец есть с Ф2), идентификаторы, обращения, согласия и вложения переносятся
-- к основному клиенту; дубль скрывается из поиска. Кто и когда объединил — здесь и в журнале аудита.
ALTER TABLE contact ADD COLUMN IF NOT EXISTS merged_at timestamptz;
ALTER TABLE contact ADD COLUMN IF NOT EXISTS merged_by uuid REFERENCES app_user (id);
-- Право «объединять клиентов»: администратор и супервизор.
UPDATE role SET permissions = array_append(permissions, 'contacts.merge')
 WHERE code IN ('admin', 'supervisor') AND NOT ('contacts.merge' = ANY(permissions));

-- ---------- M-OP-02: вкладка «Постобработка» ----------
-- Чат попадает во вкладку, если после ответа оператора клиент молчит дольше заданного (с); звонок — после отбоя.
INSERT INTO system_setting (key, value) VALUES ('operator.wrapup_chat_idle_s', '300') ON CONFLICT (key) DO NOTHING;

-- ---------- M-OP-05 / M-TKT-11: консультативный перевод ----------
-- Во время консультации клиент на удержании, оператор говорит с адресатом по второму каналу; состояние — в строке
-- вызова (переживает смену активного call-control, 02-архитектура 6.3). target: адресат для журнала и перевода.
ALTER TABLE call ADD COLUMN IF NOT EXISTS consult_channel text;
ALTER TABLE call ADD COLUMN IF NOT EXISTS consult_state text;
ALTER TABLE call ADD COLUMN IF NOT EXISTS consult_user_id uuid REFERENCES app_user (id);
ALTER TABLE call ADD COLUMN IF NOT EXISTS consult_target jsonb;
