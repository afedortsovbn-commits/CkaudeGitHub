-- Д-094 (16.10.2026): матрица уведомлений «сотрудник × событие». На пересечении — каналы (в программе, почта,
-- Telegram) и условия получения (всегда / если ответственный / куратор / создатель / ведёт обращение). Дополняет
-- правила `notify_rule` (роли), не заменяет их. Сотрудник: Telegram, указанный в справочнике. Только expand-изменения.
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS notify_matrix (
  user_id    uuid        NOT NULL REFERENCES app_user (id),
  event      text        NOT NULL,
  channels   text[]      NOT NULL DEFAULT '{}',
  conditions text[]      NOT NULL DEFAULT '{all}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES app_user (id),
  PRIMARY KEY (user_id, event)
);
CREATE INDEX IF NOT EXISTS notify_matrix_event_idx ON notify_matrix (event);

-- Telegram сотрудника из справочника (@имя или номер чата). Отправка идёт в чат, привязанный кодом из профиля
-- (`telegram_chat_id`); если там пусто, а здесь номер чата, — в него.
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS telegram_contact text;
