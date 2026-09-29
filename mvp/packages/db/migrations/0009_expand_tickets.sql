-- Ф8: вторая линия — тикеты, назначенные, комментарии и документы, история переходов, заместители по
-- согласованию, журнал уведомлений (интерфейс и email). Только expand-изменения.
SET lock_timeout = '5s';

INSERT INTO system_setting (key, value) VALUES
  ('ticket.transfer_message', '"Ваше обращение передано специалисту профильного подразделения. Мы свяжемся с вами."')
ON CONFLICT (key) DO NOTHING;

CREATE SEQUENCE IF NOT EXISTS ticket_number_seq START 1000;

-- ---------- Тикет 2-й линии (M-TKT-01..03) ----------
CREATE TABLE IF NOT EXISTS ticket (
  id                       uuid PRIMARY KEY,
  number                   bigint      NOT NULL DEFAULT nextval('ticket_number_seq') UNIQUE,
  conversation_id          uuid        NOT NULL REFERENCES conversation (id),
  -- «Направлено в»: подразделение на предприятии; отдельные столбцы — для отчётов и области видимости.
  enterprise_department_id uuid        NOT NULL REFERENCES enterprise_department (id),
  enterprise_id            uuid        NOT NULL REFERENCES enterprise (id),
  department_id            uuid        NOT NULL REFERENCES department (id),
  topic_id                 uuid        NOT NULL REFERENCES topic (id),
  topic_path               uuid[]      NOT NULL,
  is_important             boolean     NOT NULL DEFAULT false,
  important_manual         boolean     NOT NULL DEFAULT false,
  status                   text        NOT NULL DEFAULT 'new'
                             CHECK (status IN ('new', 'in_work', 'approval', 'rework', 'closed')),
  -- Суть обращения для ответственных (пишет оператор при передаче).
  summary                  text        NOT NULL,
  -- Срок ответа: последний день (конец дня по Europe/Minsk, M-TKT-03).
  due_date                 date        NOT NULL,
  created_by               uuid        NOT NULL REFERENCES app_user (id),
  -- Последнее закрытие ответственным.
  answer_method_id         uuid REFERENCES answer_method (id),
  answer_summary           text,
  answered_at              timestamptz,
  returns_count            integer     NOT NULL DEFAULT 0,
  -- Ожидание согласования не засчитывается в просрочку ответственного (M-TKT-03).
  approval_wait_since      timestamptz,
  approval_wait_s          bigint      NOT NULL DEFAULT 0,
  closed_at                timestamptz,
  closed_in_time           boolean,
  approved_by              uuid REFERENCES app_user (id),
  -- Оптимистическая блокировка: одновременные действия нескольких назначенных (M-TKT-03).
  version                  integer     NOT NULL DEFAULT 1,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
-- Не более одного открытого тикета на обращение (защита от повторной передачи).
CREATE UNIQUE INDEX IF NOT EXISTS ticket_open_conversation_uq ON ticket (conversation_id) WHERE status <> 'closed';
CREATE INDEX IF NOT EXISTS ticket_conversation_idx ON ticket (conversation_id);
CREATE INDEX IF NOT EXISTS ticket_open_due_idx ON ticket (due_date) WHERE status <> 'closed';
CREATE INDEX IF NOT EXISTS ticket_created_by_idx ON ticket (created_by, status);
CREATE INDEX IF NOT EXISTS ticket_status_idx ON ticket (status, updated_at);

-- Фактический состав назначенных (подстановка по матрице фиксируется здесь и не меняется при правке матрицы).
CREATE TABLE IF NOT EXISTS ticket_assignee (
  ticket_id      uuid        NOT NULL REFERENCES ticket (id),
  user_id        uuid        NOT NULL REFERENCES app_user (id),
  kind           text        NOT NULL CHECK (kind IN ('responsible', 'curator')),
  is_active      boolean     NOT NULL DEFAULT true,
  added_at       timestamptz NOT NULL DEFAULT now(),
  added_by       uuid REFERENCES app_user (id),
  removed_at     timestamptz,
  removed_reason text,
  PRIMARY KEY (ticket_id, user_id)
);
CREATE INDEX IF NOT EXISTS ticket_assignee_user_idx ON ticket_assignee (user_id) WHERE is_active;

-- Комментарии, ответы ответственного, возвраты и переадресации; вложения — документы (M-TKT-07/08).
CREATE TABLE IF NOT EXISTS ticket_comment (
  id          uuid PRIMARY KEY,
  ticket_id   uuid        NOT NULL REFERENCES ticket (id),
  author_id   uuid REFERENCES app_user (id),
  kind        text        NOT NULL CHECK (kind IN ('comment', 'answer', 'return', 'redirect', 'system')),
  body        text        NOT NULL,
  attachments jsonb       NOT NULL DEFAULT '[]',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ticket_comment_ticket_idx ON ticket_comment (ticket_id, created_at);

-- История: все переходы, переадресации, смена ответственных и срока (M-TKT-03).
CREATE TABLE IF NOT EXISTS ticket_transition (
  id          uuid PRIMARY KEY,
  ticket_id   uuid        NOT NULL REFERENCES ticket (id),
  at          timestamptz NOT NULL DEFAULT now(),
  actor_id    uuid REFERENCES app_user (id),
  action      text        NOT NULL,
  from_status text,
  to_status   text,
  details     jsonb       NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS ticket_transition_ticket_idx ON ticket_transition (ticket_id, at);

ALTER TABLE attachment ADD COLUMN IF NOT EXISTS ticket_id uuid REFERENCES ticket (id);

-- ---------- Заместители по согласованию (M-TKT-09) ----------
CREATE TABLE IF NOT EXISTS approval_substitute (
  id            uuid PRIMARY KEY,
  user_id       uuid        NOT NULL REFERENCES app_user (id),
  substitute_id uuid        NOT NULL REFERENCES app_user (id),
  -- Период отсутствия; NULL — без ограничения.
  valid_from    date,
  valid_to      date,
  created_by    uuid REFERENCES app_user (id),
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (user_id <> substitute_id)
);
CREATE INDEX IF NOT EXISTS approval_substitute_user_idx ON approval_substitute (user_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS approval_substitute_sub_idx ON approval_substitute (substitute_id) WHERE is_active;

-- ---------- Уведомления: интерфейс (колокольчик) и email (M-TKT-04, M-TKT-12) ----------
-- dedupe_key уникален: перезапуск или замена worker во время рассылки не даёт ни дублей, ни пропусков.
CREATE TABLE IF NOT EXISTS notification (
  id              uuid PRIMARY KEY,
  user_id         uuid        NOT NULL REFERENCES app_user (id),
  ticket_id       uuid REFERENCES ticket (id),
  kind            text        NOT NULL,
  channel         text        NOT NULL CHECK (channel IN ('ui', 'email')),
  dedupe_key      text        NOT NULL UNIQUE,
  subject         text        NOT NULL,
  body            text        NOT NULL DEFAULT '',
  data            jsonb       NOT NULL DEFAULT '{}',
  -- Для email: pending → sent | failed (после исчерпания повторов); для интерфейса всегда sent.
  status          text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts        integer     NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  read_at         timestamptz
);
CREATE INDEX IF NOT EXISTS notification_ui_idx ON notification (user_id, created_at DESC) WHERE channel = 'ui';
CREATE INDEX IF NOT EXISTS notification_email_pending_idx ON notification (next_attempt_at)
  WHERE channel = 'email' AND status = 'pending';
CREATE INDEX IF NOT EXISTS notification_ticket_idx ON notification (ticket_id);
