-- Тестирование операторов и специалистов (доработки 09.10.2026): тесты с вопросами по темам, назначения со сроком,
-- все попытки и ответы хранятся (компетентность по темам, рейтинг вопросов), напоминания о сроке.
SET lock_timeout = '5s';

-- Тест: вопросы с вариантами ответа; темы теста — для компетентности по темам.
CREATE TABLE IF NOT EXISTS knowledge_test (
  id          uuid PRIMARY KEY,
  title       text        NOT NULL,
  description text        NOT NULL DEFAULT '',
  topic_ids   uuid[]      NOT NULL DEFAULT '{}',
  -- Проходной балл, % правильных ответов.
  pass_score  smallint    NOT NULL DEFAULT 80 CHECK (pass_score BETWEEN 1 AND 100),
  is_active   boolean     NOT NULL DEFAULT true,
  created_by  uuid REFERENCES app_user (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge_question (
  id         uuid PRIMARY KEY,
  test_id    uuid        NOT NULL REFERENCES knowledge_test (id),
  text       text        NOT NULL,
  -- Варианты: [{id, text, correct}]; правильных может быть несколько (тогда отметить нужно все).
  options    jsonb       NOT NULL DEFAULT '[]',
  sort_order int         NOT NULL DEFAULT 0,
  is_active  boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_question_test_idx ON knowledge_question (test_id, sort_order);

-- Назначение теста сотруднику со сроком. Пройдено — когда есть попытка с проходным баллом после назначения.
CREATE TABLE IF NOT EXISTS test_assignment (
  id           uuid PRIMARY KEY,
  test_id      uuid        NOT NULL REFERENCES knowledge_test (id),
  user_id      uuid        NOT NULL REFERENCES app_user (id),
  due_date     date        NOT NULL,
  assigned_by  uuid REFERENCES app_user (id),
  comment      text        NOT NULL DEFAULT '',
  passed_at    timestamptz,
  cancelled_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS test_assignment_user_idx ON test_assignment (user_id) WHERE cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS test_assignment_open_idx ON test_assignment (due_date)
  WHERE cancelled_at IS NULL AND passed_at IS NULL;

-- Попытка: вопросы фиксируются при начале (порядок, состав), оценка — при завершении.
CREATE TABLE IF NOT EXISTS test_attempt (
  id            uuid PRIMARY KEY,
  test_id       uuid        NOT NULL REFERENCES knowledge_test (id),
  user_id       uuid        NOT NULL REFERENCES app_user (id),
  assignment_id uuid REFERENCES test_assignment (id),
  question_ids  uuid[]      NOT NULL DEFAULT '{}',
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  correct       int,
  total         int,
  score         smallint,
  passed        boolean
);
CREATE INDEX IF NOT EXISTS test_attempt_user_idx ON test_attempt (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS test_attempt_test_idx ON test_attempt (test_id, started_at DESC);

-- Ответ на вопрос в попытке — для рейтинга вопросов (где чаще ошибаются) в разрезе сотрудников.
CREATE TABLE IF NOT EXISTS test_answer (
  attempt_id  uuid    NOT NULL REFERENCES test_attempt (id),
  question_id uuid    NOT NULL REFERENCES knowledge_question (id),
  user_id     uuid    NOT NULL REFERENCES app_user (id),
  chosen      jsonb   NOT NULL DEFAULT '[]',
  correct     boolean NOT NULL,
  answered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (attempt_id, question_id)
);
CREATE INDEX IF NOT EXISTS test_answer_question_idx ON test_answer (question_id);

-- Напоминания о сроке: какое напоминание по назначению уже отправлено (дата) — один раз в день.
CREATE TABLE IF NOT EXISTS test_reminder (
  assignment_id uuid NOT NULL REFERENCES test_assignment (id),
  day           date NOT NULL,
  PRIMARY KEY (assignment_id, day)
);

-- Права: тесты (создание, назначение, результаты, рейтинг вопросов) — администратор и супервизор;
-- панель рейтинга операторов — администратор, супервизор и оператор.
UPDATE role SET permissions = array_append(permissions, 'tests.manage')
 WHERE code IN ('admin', 'supervisor') AND NOT ('tests.manage' = ANY (permissions));
UPDATE role SET permissions = array_append(permissions, 'rating.view')
 WHERE code IN ('admin', 'supervisor', 'operator') AND NOT ('rating.view' = ANY (permissions));
