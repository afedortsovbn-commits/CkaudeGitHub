-- Д-064 (15.10.2026): пакетная загрузка и правка обращений из Excel. Только expand-изменения.
SET lock_timeout = '5s';

-- Код обращения во внешней (прежней) системе: по нему повторная загрузка того же файла находит уже загруженные
-- обращения и правит их, а не создаёт дубли.
ALTER TABLE conversation ADD COLUMN IF NOT EXISTS external_code text;
CREATE UNIQUE INDEX IF NOT EXISTS conversation_external_code_uq ON conversation (external_code)
  WHERE external_code IS NOT NULL;

-- Загрузка: разобранный файл (что будет создано и изменено) хранится до применения; после — итог.
CREATE TABLE IF NOT EXISTS import_batch (
  id          uuid PRIMARY KEY,
  kind        text        NOT NULL DEFAULT 'conversations',
  file_name   text        NOT NULL DEFAULT '',
  created_by  uuid REFERENCES app_user (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Сводка проверки: строк, новых, изменений по полям, дублей, ошибок по причинам.
  summary     jsonb       NOT NULL DEFAULT '{}',
  -- Разобранные строки: план действий по каждой строке и ошибки по ячейкам (для файла с отметками).
  plan        jsonb       NOT NULL DEFAULT '[]',
  header      jsonb       NOT NULL DEFAULT '[]',
  applied_at  timestamptz,
  applied_by  uuid REFERENCES app_user (id),
  result      jsonb
);
CREATE INDEX IF NOT EXISTS import_batch_created_idx ON import_batch (created_at DESC);

-- Права: загрузка обращений и обновление системы (Д-065) — администратору.
UPDATE role SET permissions = array_append(permissions, 'data.import')
 WHERE code = 'admin' AND NOT ('data.import' = ANY (permissions));
UPDATE role SET permissions = array_append(permissions, 'system.update')
 WHERE code = 'admin' AND NOT ('system.update' = ANY (permissions));
