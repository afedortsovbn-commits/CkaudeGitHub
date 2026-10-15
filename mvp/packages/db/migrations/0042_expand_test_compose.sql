-- Д-062 (15.10.2026): сборные тесты супервизора — вопросы берутся из нескольких тестов, в попытку попадает
-- заданное число случайных вопросов. Только expand: новые столбцы со значениями по умолчанию.
SET lock_timeout = '5s';

-- Тесты-источники: если не пусто — тест сборный, своих вопросов у него нет.
ALTER TABLE knowledge_test ADD COLUMN IF NOT EXISTS source_test_ids uuid[] NOT NULL DEFAULT '{}';
-- Сколько случайных вопросов давать в попытке; NULL — все вопросы (по порядку, как раньше).
ALTER TABLE knowledge_test ADD COLUMN IF NOT EXISTS question_count integer CHECK (question_count IS NULL OR question_count > 0);
