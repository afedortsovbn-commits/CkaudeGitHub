-- Список «Закрытые» на рабочем месте (ORDER BY closed_at DESC LIMIT 200): без индекса — сортировка всей таблицы
-- обращений (на объёме года работы ~190 мс и растёт), с индексом — ~4 мс (проверка 08.10.2026, 300 тыс. обращений).
SET lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS conversation_closed_idx ON conversation (closed_at DESC) WHERE status = 'closed';
