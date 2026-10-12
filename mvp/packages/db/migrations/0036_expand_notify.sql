-- Д-012 настраиваемые уведомления о событиях, Д-011 минимум операторов на линии, Д-013 копии писем и отписка,
-- Д-010 Telegram-бот для сотрудников (12.10.2026). Только expand-изменения.
SET lock_timeout = '5s';

-- Канал уведомления «telegram» (расширение CHECK; прежние значения остаются допустимыми).
ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_channel_check;
ALTER TABLE notification ADD CONSTRAINT notification_channel_check CHECK (channel IN ('ui', 'email', 'telegram'));
CREATE INDEX IF NOT EXISTS notification_telegram_pending_idx ON notification (next_attempt_at)
  WHERE channel = 'telegram' AND status = 'pending';

-- Сотрудник: привязанный Telegram (чат с ботом для сотрудников), код привязки; отписка от писем и её токен.
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS telegram_chat_id text;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS telegram_link_code text;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS telegram_linked_at timestamptz;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS email_unsubscribed_at timestamptz;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS unsubscribe_token text;
CREATE INDEX IF NOT EXISTS app_user_telegram_chat_idx ON app_user (telegram_chat_id) WHERE telegram_chat_id IS NOT NULL;

-- Правила уведомлений: по какому событию, каким каналом и кому (роли и/или сотрудники).
CREATE TABLE IF NOT EXISTS notify_rule (
  id         uuid PRIMARY KEY,
  event      text        NOT NULL,
  name       text        NOT NULL DEFAULT '',
  channels   text[]      NOT NULL DEFAULT '{ui}',
  role_codes text[]      NOT NULL DEFAULT '{}',
  user_ids   uuid[]      NOT NULL DEFAULT '{}',
  params     jsonb       NOT NULL DEFAULT '{}',
  is_active  boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notify_rule_event_idx ON notify_rule (event) WHERE is_active;

-- Уведомления «по желанию сотрудника»: событие → каналы (пусто — не получать).
CREATE TABLE IF NOT EXISTS user_notify_pref (
  user_id  uuid   NOT NULL REFERENCES app_user (id),
  event    text   NOT NULL,
  channels text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (user_id, event)
);

-- Минимум операторов на линии по дням недели (1 — понедельник … 7) и часам (0…23).
CREATE TABLE IF NOT EXISTS staffing_minimum (
  weekday  integer NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  hour     integer NOT NULL CHECK (hour BETWEEN 0 AND 23),
  required integer NOT NULL DEFAULT 0 CHECK (required >= 0),
  PRIMARY KEY (weekday, hour)
);

-- Настройки: бот Telegram для сотрудников (токен, адрес Bot API, адрес мини-приложения) и политика писем
-- (копии на адреса владельца, текст про отписку).
INSERT INTO system_setting (key, value) VALUES
  ('notify.telegram', '{"botToken": null, "apiRoot": null, "miniAppUrl": null}'),
  ('mail.policy', '{"copyTo": ["A.Fedortsov@beloil.by", "Alex_Fedortsov@mail.ru"]}')
ON CONFLICT (key) DO NOTHING;

-- Правила по умолчанию: супервизорам и администраторам — в интерфейс (и письмом для минимума операторов и
-- просроченных тикетов). Только если правил ещё нет.
INSERT INTO notify_rule (id, event, name, channels, role_codes)
SELECT gen_random_uuid(), e.event, e.name, e.channels, '{supervisor,admin}'
  FROM (VALUES
    ('operators.below_min', 'Операторов на линии меньше минимума', '{ui,email}'::text[]),
    ('queue.long_wait', 'Клиент ждёт в очереди дольше порога', '{ui}'::text[]),
    ('queue.no_free', 'В очереди есть клиенты, свободных операторов нет', '{ui}'::text[]),
    ('conversation.overdue', 'Просрочен срок ответа на обращение', '{ui}'::text[]),
    ('review.negative', 'Поступил негативный отзыв', '{ui}'::text[]),
    ('ticket.overdue', 'Просрочен тикет 2-й линии', '{ui,email}'::text[]),
    ('break.violation', 'Нарушение перерыва по графику', '{ui}'::text[]),
    ('resource.alert', 'Ресурсы сервера на пределе', '{ui,email}'::text[])
  ) AS e(event, name, channels)
 WHERE NOT EXISTS (SELECT 1 FROM notify_rule);
