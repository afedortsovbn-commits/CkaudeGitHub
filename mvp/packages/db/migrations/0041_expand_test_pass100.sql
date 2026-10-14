-- Д-054 (14.10.2026): проходной балл тестов — 100 % по умолчанию и у всех существующих тестов (решение владельца).
-- Только expand: новое значение по умолчанию и обновление данных, структура не меняется.
SET lock_timeout = '5s';

ALTER TABLE knowledge_test ALTER COLUMN pass_score SET DEFAULT 100;
UPDATE knowledge_test SET pass_score = 100 WHERE pass_score <> 100;
