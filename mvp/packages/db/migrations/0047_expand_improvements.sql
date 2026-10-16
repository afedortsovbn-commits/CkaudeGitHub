-- Д-098, Д-099 (16.10.2026): робот предложений по улучшению. Раз в сутки (и по кнопке) анализирует обращения,
-- оценки, 2-ю линию, исправления нейросети, очереди и ответы операторов: предложения с категорией, темой, частотой
-- и рейтингом; ручные статусы (важное, в работе, сделано, не принимается). Частые ответы операторов —
-- кандидаты в шаблоны. Только expand-изменения.
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS improvement_proposal (
  id            uuid PRIMARY KEY,
  -- Правило робота (topic_growth, repeat_contacts, low_csat, …) или manual; subject_key — что именно (тема,
  -- подразделение, поле, час): повторная находка обновляет ту же запись, статус и заметка сохраняются.
  rule          text        NOT NULL,
  subject_key   text        NOT NULL,
  title         text        NOT NULL,
  details       text        NOT NULL DEFAULT '',
  category      text        NOT NULL CHECK (category IN ('software', 'process', 'knowledge', 'staff', 'automation')),
  topic_id      uuid REFERENCES topic (id),
  frequency     integer     NOT NULL DEFAULT 0,
  rating        integer     NOT NULL DEFAULT 0,
  metrics       jsonb       NOT NULL DEFAULT '{}',
  status        text        NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new', 'important', 'in_work', 'done', 'rejected')),
  note          text        NOT NULL DEFAULT '',
  status_by     uuid REFERENCES app_user (id),
  status_at     timestamptz,
  created_by    uuid REFERENCES app_user (id),
  is_current    boolean     NOT NULL DEFAULT true,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule, subject_key)
);
CREATE INDEX IF NOT EXISTS improvement_proposal_rating_idx ON improvement_proposal (is_current, rating DESC);

CREATE TABLE IF NOT EXISTS template_suggestion (
  id            uuid PRIMARY KEY,
  text_key      text        NOT NULL UNIQUE,
  body          text        NOT NULL,
  uses          integer     NOT NULL DEFAULT 0,
  operators     integer     NOT NULL DEFAULT 0,
  topic_id      uuid REFERENCES topic (id),
  status        text        NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'accepted', 'rejected')),
  template_id   uuid REFERENCES reply_template (id),
  decided_by    uuid REFERENCES app_user (id),
  decided_at    timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);

-- Право «Предложения по улучшению» — администратору и супервизору.
UPDATE role SET permissions = array_append(permissions, 'improvements.manage')
 WHERE code IN ('admin', 'supervisor') AND NOT ('improvements.manage' = ANY (permissions));
