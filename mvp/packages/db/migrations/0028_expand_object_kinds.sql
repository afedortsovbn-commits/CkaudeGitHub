-- Что оператор выбирает в карточке обращения (доработки 08.10.2026): АЗС, электрозарядные станции (ЭЗС) или оба.
SET lock_timeout = '5s';

-- Вид объекта справочника: АЗС или ЭЗС (сеть «Маланка»).
ALTER TABLE service_object ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'azs'
  CHECK (kind IN ('azs', 'ezs'));
CREATE INDEX IF NOT EXISTS service_object_kind_idx ON service_object (kind);

-- Какие объекты выбираются по теме: NULL — как у родительской темы (у темы верхнего уровня — только АЗС).
ALTER TABLE topic ADD COLUMN IF NOT EXISTS object_kinds text[];
