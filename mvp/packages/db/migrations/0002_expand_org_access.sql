-- Ф1: оргструктура, сотрудники, роли и области видимости, справочники, матрица ответственности, аудит.
-- Только expand-изменения. Удаление записей — деактивация (is_active = false), история не ломается.
SET lock_timeout = '5s';

-- ---------- Настройки системы ----------
CREATE TABLE IF NOT EXISTS system_setting (
  key        text PRIMARY KEY,
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO system_setting (key, value) VALUES
  ('ticket.default_response_days', '15'),
  ('ticket.daily_notification_time', '"08:00"'),
  ('ticket.approval_mode', '"creator"'),
  ('system.timezone', '"Europe/Minsk"')
ON CONFLICT (key) DO NOTHING;

-- ---------- Предприятия и подразделения ----------
CREATE TABLE IF NOT EXISTS enterprise (
  id          uuid PRIMARY KEY,
  code        text        NOT NULL UNIQUE,
  name        text        NOT NULL,
  email       text,
  phone       text,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Подразделение не принадлежит предприятию: связь многие-ко-многим (M-ORG-02).
CREATE TABLE IF NOT EXISTS department (
  id          uuid PRIMARY KEY,
  code        text        NOT NULL UNIQUE,
  name        text        NOT NULL,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- «Подразделение на предприятии» — сюда направляются тикеты; свой телефон/очередь для перевода и email.
CREATE TABLE IF NOT EXISTS enterprise_department (
  id                uuid PRIMARY KEY,
  enterprise_id     uuid        NOT NULL REFERENCES enterprise (id),
  department_id     uuid        NOT NULL REFERENCES department (id),
  transfer_number   text,
  transfer_queue_id uuid,
  email             text,
  is_active         boolean     NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (enterprise_id, department_id)
);
CREATE INDEX IF NOT EXISTS enterprise_department_dep_idx ON enterprise_department (department_id);

-- ---------- Темы (3 уровня) и поля карточки ----------
CREATE TABLE IF NOT EXISTS topic (
  id                    uuid PRIMARY KEY,
  parent_id             uuid REFERENCES topic (id),
  level                 smallint    NOT NULL CHECK (level BETWEEN 1 AND 3),
  path                  uuid[]      NOT NULL, -- предки и сама тема: [корень, …, id]
  code                  text,
  name                  text        NOT NULL,
  is_important          boolean     NOT NULL DEFAULT false,
  default_response_days integer CHECK (default_response_days IS NULL OR default_response_days BETWEEN 1 AND 365),
  sort_order            integer     NOT NULL DEFAULT 0,
  is_active             boolean     NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS topic_parent_idx ON topic (parent_id);
CREATE INDEX IF NOT EXISTS topic_path_gin ON topic USING gin (path);

-- Путь и уровень вычисляются по родителю; перенос темы к другому родителю в MVP не поддерживается.
CREATE OR REPLACE FUNCTION topic_set_path() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_path uuid[];
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN
    RAISE EXCEPTION 'перенос темы к другому родителю не поддерживается';
  END IF;
  IF NEW.parent_id IS NULL THEN
    NEW.path := ARRAY[NEW.id];
  ELSE
    SELECT path INTO parent_path FROM topic WHERE id = NEW.parent_id;
    IF parent_path IS NULL THEN RAISE EXCEPTION 'родительская тема не найдена'; END IF;
    NEW.path := parent_path || NEW.id;
  END IF;
  NEW.level := array_length(NEW.path, 1);
  RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER topic_path_trg BEFORE INSERT OR UPDATE ON topic
  FOR EACH ROW EXECUTE FUNCTION topic_set_path();

CREATE TABLE IF NOT EXISTS field_def (
  id                   uuid PRIMARY KEY,
  topic_id             uuid        NOT NULL REFERENCES topic (id),
  key                  text        NOT NULL,
  label                text        NOT NULL,
  type                 text        NOT NULL CHECK (type IN ('text', 'number', 'date', 'select', 'phone', 'email')),
  mask                 text,
  options              jsonb,
  required_on_close    boolean     NOT NULL DEFAULT false,
  required_on_escalate boolean     NOT NULL DEFAULT false,
  sort_order           integer     NOT NULL DEFAULT 0,
  is_active            boolean     NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (topic_id, key)
);

-- ---------- Объекты (АЗС/ЭЗС) ----------
CREATE TABLE IF NOT EXISTS service_object (
  id            uuid PRIMARY KEY,
  enterprise_id uuid        NOT NULL REFERENCES enterprise (id),
  code          text        NOT NULL UNIQUE,
  name          text        NOT NULL,
  address       text,
  external_ids  jsonb       NOT NULL DEFAULT '{}',
  source        text        NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import', 'sync')),
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS service_object_enterprise_idx ON service_object (enterprise_id);

-- ---------- Простые справочники ----------
CREATE TABLE IF NOT EXISTS disposition (
  id         uuid PRIMARY KEY,
  code       text        NOT NULL UNIQUE,
  name       text        NOT NULL,
  behavior   text        NOT NULL CHECK (behavior IN ('resolved', 'escalate', 'no_reply_needed', 'postponed', 'duplicate')),
  sort_order integer     NOT NULL DEFAULT 0,
  is_active  boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS answer_method (
  id         uuid PRIMARY KEY,
  code       text        NOT NULL UNIQUE,
  name       text        NOT NULL,
  sort_order integer     NOT NULL DEFAULT 0,
  is_active  boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tag (
  id         uuid PRIMARY KEY,
  name       text        NOT NULL UNIQUE,
  is_active  boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS break_reason (
  id         uuid PRIMARY KEY,
  name       text        NOT NULL UNIQUE,
  is_active  boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS skill (
  id         uuid PRIMARY KEY,
  name       text        NOT NULL UNIQUE,
  topic_id   uuid REFERENCES topic (id),
  is_active  boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS queue (
  id          uuid PRIMARY KEY,
  name        text        NOT NULL UNIQUE,
  channels    text[]      NOT NULL DEFAULT '{}',
  priority    integer     NOT NULL DEFAULT 0,
  max_wait_s  integer,
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS schedule (
  id         uuid PRIMARY KEY,
  name       text        NOT NULL UNIQUE,
  timezone   text        NOT NULL DEFAULT 'Europe/Minsk',
  week       jsonb       NOT NULL DEFAULT '{}', -- {"mon":[["08:00","20:00"]], …}
  holidays   date[]      NOT NULL DEFAULT '{}',
  is_active  boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Сотрудники, роли, области видимости ----------
CREATE TABLE IF NOT EXISTS app_user (
  id                         uuid PRIMARY KEY,
  full_name                  text        NOT NULL,
  email                      text        NOT NULL,
  phone                      text,
  password_hash              text,
  can_login                  boolean     NOT NULL DEFAULT true,
  primary_enterprise_id      uuid REFERENCES enterprise (id),
  primary_department_id      uuid REFERENCES department (id),
  failed_login_attempts      integer     NOT NULL DEFAULT 0,
  locked_until               timestamptz,
  is_active                  boolean     NOT NULL DEFAULT true,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS app_user_email_uq ON app_user (lower(email));

CREATE TABLE IF NOT EXISTS role (
  code        text PRIMARY KEY,
  name        text        NOT NULL,
  permissions text[]      NOT NULL DEFAULT '{}',
  is_system   boolean     NOT NULL DEFAULT false
);
INSERT INTO role (code, name, permissions, is_system) VALUES
  ('admin', 'Администратор',
   '{scope.all,admin.users,admin.directories,admin.matrix,admin.settings,admin.audit,conversations.work,tickets.work,supervisor.monitor,supervisor.approvals}', true),
  ('supervisor', 'Супервизор', '{conversations.work,supervisor.monitor,supervisor.approvals,matrix.view}', true),
  ('operator', 'Оператор', '{conversations.work}', true),
  ('responsible', 'Ответственный / куратор (2-я линия)', '{tickets.work}', true)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS user_role (
  user_id   uuid NOT NULL REFERENCES app_user (id),
  role_code text NOT NULL REFERENCES role (code),
  PRIMARY KEY (user_id, role_code)
);

-- Правило области: предприятия × подразделения × темы; NULL в измерении = «все». Правила пользователя
-- объединяются по ИЛИ. Тема покрывает всё своё поддерево (M-ORG-07).
CREATE TABLE IF NOT EXISTS access_scope (
  id             uuid PRIMARY KEY,
  user_id        uuid        NOT NULL REFERENCES app_user (id),
  enterprise_ids uuid[],
  department_ids uuid[],
  topic_ids      uuid[],
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS access_scope_user_idx ON access_scope (user_id);

CREATE TABLE IF NOT EXISTS scope_template (
  id         uuid PRIMARY KEY,
  name       text        NOT NULL UNIQUE,
  rules      jsonb       NOT NULL DEFAULT '[]',
  is_active  boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_skill (
  user_id  uuid     NOT NULL REFERENCES app_user (id),
  skill_id uuid     NOT NULL REFERENCES skill (id),
  level    smallint NOT NULL DEFAULT 50 CHECK (level BETWEEN 0 AND 100),
  PRIMARY KEY (user_id, skill_id)
);

CREATE TABLE IF NOT EXISTS user_queue (
  user_id  uuid NOT NULL REFERENCES app_user (id),
  queue_id uuid NOT NULL REFERENCES queue (id),
  PRIMARY KEY (user_id, queue_id)
);

-- Сессии: refresh-токен хранится только в виде хэша, ротация при каждом обновлении.
CREATE TABLE IF NOT EXISTS auth_session (
  id           uuid PRIMARY KEY,
  user_id      uuid        NOT NULL REFERENCES app_user (id),
  refresh_hash text        NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  user_agent   text,
  ip           text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_session_user_idx ON auth_session (user_id);

-- ---------- Матрица ответственности (M-ORG-05) ----------
CREATE TABLE IF NOT EXISTS responsibility (
  id                       uuid PRIMARY KEY,
  enterprise_department_id uuid        NOT NULL REFERENCES enterprise_department (id),
  topic_id                 uuid        NOT NULL REFERENCES topic (id),
  user_id                  uuid        NOT NULL REFERENCES app_user (id),
  kind                     text        NOT NULL CHECK (kind IN ('responsible', 'curator')),
  is_active                boolean     NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (enterprise_department_id, topic_id, user_id, kind)
);
CREATE INDEX IF NOT EXISTS responsibility_lookup_idx ON responsibility (enterprise_department_id, topic_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS responsibility_user_idx ON responsibility (user_id);

-- ---------- Журнал аудита (неизменяемый, FS-LOG-01) ----------
CREATE TABLE IF NOT EXISTS audit_log (
  id         uuid PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  actor_id   uuid,
  action     text        NOT NULL,
  entity     text        NOT NULL,
  entity_id  text,
  before     jsonb,
  after      jsonb,
  ip         text
);
CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON audit_log (entity, entity_id, at);
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at);
CREATE OR REPLACE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION event_forbid_mutation();
