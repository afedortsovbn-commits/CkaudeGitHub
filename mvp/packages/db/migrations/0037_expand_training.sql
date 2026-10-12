-- Д-014 система обучения сотрудников (12.10.2026): курсы из уроков (текст, картинки, подсказки, шаги, ситуации
-- «как поступить»), тест после урока (knowledge_test), назначение и повторное прохождение, отметки прохождения.
-- Содержание курсов — данные (загружаются скриптом из папки справочников), не код. Только expand-изменения.
SET lock_timeout = '5s';

-- Картинки и файлы курсов (отдельно от вложений обращений: доступны всем сотрудникам).
CREATE TABLE IF NOT EXISTS course_asset (
  id           uuid PRIMARY KEY,
  filename     text        NOT NULL,
  content_type text        NOT NULL,
  size_bytes   bigint      NOT NULL DEFAULT 0,
  storage_key  text        NOT NULL,
  uploaded_by  uuid REFERENCES app_user (id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS course (
  id             uuid PRIMARY KEY,
  code           text,
  title          text        NOT NULL,
  description    text        NOT NULL DEFAULT '',
  topic_ids      uuid[]      NOT NULL DEFAULT '{}',
  cover_asset_id uuid REFERENCES course_asset (id),
  -- Оформление карточки курса: цвет и значок (имя значка Tabler), если нет обложки.
  color          text        NOT NULL DEFAULT 'green',
  icon           text        NOT NULL DEFAULT 'school',
  -- Ориентировочная длительность, мин; порядок; обязательный для новичков.
  minutes        integer     NOT NULL DEFAULT 20,
  sort_order     integer     NOT NULL DEFAULT 0,
  is_active      boolean     NOT NULL DEFAULT true,
  created_by     uuid REFERENCES app_user (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS course_code_uq ON course (code) WHERE code IS NOT NULL;

-- Урок: блоки содержимого (jsonb: text, image, tip, steps, quote, situation), тест после урока.
CREATE TABLE IF NOT EXISTS course_lesson (
  id         uuid PRIMARY KEY,
  course_id  uuid        NOT NULL REFERENCES course (id),
  title      text        NOT NULL,
  summary    text        NOT NULL DEFAULT '',
  blocks     jsonb       NOT NULL DEFAULT '[]',
  test_id    uuid REFERENCES knowledge_test (id),
  sort_order integer     NOT NULL DEFAULT 0,
  is_active  boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS course_lesson_course_idx ON course_lesson (course_id, sort_order);

-- Назначение курса сотруднику со сроком; «повторно» — новое назначение поверх пройденного.
CREATE TABLE IF NOT EXISTS course_assignment (
  id           uuid PRIMARY KEY,
  course_id    uuid        NOT NULL REFERENCES course (id),
  user_id      uuid        NOT NULL REFERENCES app_user (id),
  due_date     date        NOT NULL,
  assigned_by  uuid REFERENCES app_user (id),
  comment      text        NOT NULL DEFAULT '',
  is_repeat    boolean     NOT NULL DEFAULT false,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS course_assignment_user_idx ON course_assignment (user_id) WHERE cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS course_assignment_open_idx ON course_assignment (due_date)
  WHERE cancelled_at IS NULL AND completed_at IS NULL;

-- Прохождение урока: в рамках назначения (scope = id назначения) или самостоятельно (scope = 'self').
CREATE TABLE IF NOT EXISTS course_progress (
  user_id             uuid        NOT NULL REFERENCES app_user (id),
  lesson_id           uuid        NOT NULL REFERENCES course_lesson (id),
  scope               text        NOT NULL DEFAULT 'self',
  read_at             timestamptz,
  -- Ответы на ситуации: {id ситуации: id варианта}; верных / всего.
  answers             jsonb       NOT NULL DEFAULT '{}',
  situations_total    integer     NOT NULL DEFAULT 0,
  situations_correct  integer     NOT NULL DEFAULT 0,
  test_passed_at      timestamptz,
  completed_at        timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, lesson_id, scope)
);
CREATE INDEX IF NOT EXISTS course_progress_lesson_idx ON course_progress (lesson_id);
