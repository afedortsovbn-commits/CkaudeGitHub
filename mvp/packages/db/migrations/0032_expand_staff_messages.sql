-- Рассылка сотрудникам (доработки 08.10.2026): сообщение от администратора или супервизора всем или выбранным
-- ролям; у сотрудника всплывает окно с кнопкой «Прочитал(а)», автор видит, кто прочитал и кто нет.
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS staff_message (
  id         uuid PRIMARY KEY,
  author_id  uuid        NOT NULL REFERENCES app_user (id),
  importance text        NOT NULL DEFAULT 'normal' CHECK (importance IN ('normal', 'important', 'urgent')),
  subject    text        NOT NULL,
  body       text        NOT NULL DEFAULT '',
  -- Кому: все или роли, только находящиеся на линии (для истории рассылки).
  audience   jsonb       NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_message_created_idx ON staff_message (created_at DESC);

CREATE TABLE IF NOT EXISTS staff_message_recipient (
  message_id  uuid        NOT NULL REFERENCES staff_message (id),
  user_id     uuid        NOT NULL REFERENCES app_user (id),
  read_at     timestamptz,
  reminded_at timestamptz,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS staff_message_recipient_unread_idx ON staff_message_recipient (user_id) WHERE read_at IS NULL;

-- Право на рассылку: администратор и супервизор.
UPDATE role SET permissions = array_append(permissions, 'staff.broadcast')
 WHERE code IN ('admin', 'supervisor') AND NOT ('staff.broadcast' = ANY (permissions));
