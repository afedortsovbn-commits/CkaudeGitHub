-- cc:no-transaction
-- Тестовая миграция «версии N+1» для ops/zero-downtime-test (только стенды проверки, в поставку не входит):
-- новый столбец и индекс на «горячей» таблице сообщений под нагрузкой — без долгих блокировок
-- (ADD COLUMN без DEFAULT — только каталог; индекс CONCURRENTLY; lock_timeout раннера с повтором).
ALTER TABLE message ADD COLUMN IF NOT EXISTS zdt_probe text;
CREATE INDEX CONCURRENTLY IF NOT EXISTS message_zdt_probe_idx ON message (zdt_probe) WHERE zdt_probe IS NOT NULL;
CREATE TABLE IF NOT EXISTS zdt_probe (id uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
