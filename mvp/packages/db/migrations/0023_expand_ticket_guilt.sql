-- Закрытие на 2-й линии (доработки 06.10.2026): вина работника и принятые меры обязательны, по ним — фильтры и выгрузка.
SET lock_timeout = '5s';
ALTER TABLE ticket ADD COLUMN IF NOT EXISTS staff_guilty boolean;
ALTER TABLE ticket ADD COLUMN IF NOT EXISTS measures text[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS ticket_staff_guilty_idx ON ticket (staff_guilty) WHERE staff_guilty IS NOT NULL;
