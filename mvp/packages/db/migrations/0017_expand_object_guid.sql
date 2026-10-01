-- Ф13b (описания заказчика 01.10, В-32/В-42): справочник объектов синхронизируется из АСУ НПО ЭК, ключ — GUID объекта
-- (`objguid`) в service_object.external_ids; по нему же отзыв Rocket Data (`StationGuid`) сопоставляется АЗС.
-- В отзыве GUID приходит с дефисами, в выгрузке — без: сравнение без дефисов и регистра. Только expand-изменения.
SET lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS service_object_objguid_idx
  ON service_object ((upper(replace(external_ids ->> 'objguid', '-', ''))));
