-- График работы персонала (доработки 07.10.2026): смены, потребность, пожелания сотрудников, график на месяц
-- с перерывами. Время смен — местное (Europe/Minsk, без перехода на летнее время).
SET lock_timeout = '5s';

-- Справочник смен: начало, длительность присутствия, ночная ли (перерывы — по правилам дневной/ночной смены).
CREATE TABLE IF NOT EXISTS shift_template (
  id           uuid PRIMARY KEY,
  code         text        NOT NULL,
  name         text        NOT NULL,
  start_min    integer     NOT NULL CHECK (start_min >= 0 AND start_min < 1440),
  duration_min integer     NOT NULL CHECK (duration_min BETWEEN 60 AND 1440),
  is_night     boolean     NOT NULL DEFAULT false,
  color        text,
  sort_order   integer     NOT NULL DEFAULT 0,
  is_active    boolean     NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Потребность: сколько операторов нужно на смене в день недели (1 — понедельник … 7 — воскресенье)
-- или на конкретную дату (праздники, акции) — дата важнее дня недели.
CREATE TABLE IF NOT EXISTS schedule_demand (
  id          uuid PRIMARY KEY,
  template_id uuid        NOT NULL REFERENCES shift_template (id),
  weekday     integer CHECK (weekday BETWEEN 1 AND 7),
  on_date     date,
  required    integer     NOT NULL CHECK (required >= 0),
  CHECK ((weekday IS NULL) <> (on_date IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS schedule_demand_weekday_uq ON schedule_demand (template_id, weekday) WHERE weekday IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS schedule_demand_date_uq ON schedule_demand (template_id, on_date) WHERE on_date IS NOT NULL;

-- Пожелания сотрудника: длительности смен, ночные, дни недели, норма часов. month пусто — постоянные;
-- month задан — изменение только на этот месяц (важнее постоянных).
CREATE TABLE IF NOT EXISTS staff_pref (
  user_id        uuid        NOT NULL REFERENCES app_user (id),
  month          date,
  shift_lengths  integer[]   NOT NULL DEFAULT '{8,12}',
  night          text        NOT NULL DEFAULT 'ok' CHECK (night IN ('prefer', 'ok', 'no')),
  weekdays       jsonb       NOT NULL DEFAULT '{}',
  max_hours      integer,
  note           text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS staff_pref_uq ON staff_pref (user_id, COALESCE(month, DATE '1900-01-01'));

-- Правила сотрудника: «не может» / «хотел бы» — даты, дни недели, время; постоянные или только на месяц.
CREATE TABLE IF NOT EXISTS staff_rule (
  id         uuid PRIMARY KEY,
  user_id    uuid        NOT NULL REFERENCES app_user (id),
  kind       text        NOT NULL CHECK (kind IN ('unavailable', 'preferred')),
  date_from  date,
  date_to    date,
  weekdays   integer[],
  time_from  integer CHECK (time_from BETWEEN 0 AND 1440),
  time_to    integer CHECK (time_to BETWEEN 0 AND 1440),
  month      date,
  comment    text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_rule_user_idx ON staff_rule (user_id);

-- График на месяц: смены сотрудников и запланированные перерывы.
CREATE TABLE IF NOT EXISTS schedule_month (
  month        date PRIMARY KEY,
  status       text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  norm_hours   integer,
  generated_at timestamptz,
  published_at timestamptz,
  warnings     jsonb       NOT NULL DEFAULT '[]',
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS schedule_shift (
  id          uuid PRIMARY KEY,
  month       date        NOT NULL REFERENCES schedule_month (month),
  user_id     uuid        NOT NULL REFERENCES app_user (id),
  on_date     date        NOT NULL,
  template_id uuid        NOT NULL REFERENCES shift_template (id),
  start_at    timestamptz NOT NULL,
  end_at      timestamptz NOT NULL,
  is_night    boolean     NOT NULL DEFAULT false,
  manual      boolean     NOT NULL DEFAULT false,
  UNIQUE (user_id, on_date)
);
CREATE INDEX IF NOT EXISTS schedule_shift_month_idx ON schedule_shift (month);
CREATE INDEX IF NOT EXISTS schedule_shift_time_idx ON schedule_shift (start_at, end_at);
CREATE TABLE IF NOT EXISTS schedule_break (
  id                uuid PRIMARY KEY,
  shift_id          uuid        NOT NULL REFERENCES schedule_shift (id),
  kind              text        NOT NULL CHECK (kind IN ('long', 'short')),
  start_at          timestamptz NOT NULL,
  end_at            timestamptz NOT NULL,
  manual            boolean     NOT NULL DEFAULT false,
  -- Контроль супервизором: не ушёл на перерыв / не вернулся — уведомление один раз.
  late_start_alerted boolean    NOT NULL DEFAULT false,
  late_end_alerted   boolean    NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS schedule_break_time_idx ON schedule_break (start_at, end_at);
CREATE INDEX IF NOT EXISTS schedule_break_shift_idx ON schedule_break (shift_id);

-- Смены по умолчанию и потребность (можно изменить в разделе «График работы»).
INSERT INTO shift_template (id, code, name, start_min, duration_min, is_night, color, sort_order) VALUES
  ('01a11800-0000-7000-8000-000000000001', 'Д12', 'День 12 ч (08:00–20:00)', 480, 720, false, 'yellow', 10),
  ('01a11800-0000-7000-8000-000000000002', 'Н12', 'Ночь 12 ч (20:00–08:00)', 1200, 720, true, 'indigo', 20),
  ('01a11800-0000-7000-8000-000000000003', 'Д8', 'День 8 ч (09:00–17:45)', 540, 525, false, 'teal', 30)
ON CONFLICT (id) DO NOTHING;
INSERT INTO schedule_demand (id, template_id, weekday, required)
SELECT gen_random_uuid(), t.id, d.wd,
       CASE WHEN t.code = 'Д12' THEN CASE WHEN d.wd <= 5 THEN 2 ELSE 1 END
            WHEN t.code = 'Н12' THEN 1 ELSE CASE WHEN d.wd <= 5 THEN 1 ELSE 0 END END
  FROM shift_template t CROSS JOIN generate_series(1, 7) AS d(wd)
 WHERE t.id IN ('01a11800-0000-7000-8000-000000000001', '01a11800-0000-7000-8000-000000000002',
                '01a11800-0000-7000-8000-000000000003')
ON CONFLICT DO NOTHING;

-- Правила перерывов (дневная и ночная смена) и трудового законодательства (по умолчанию — Республика Беларусь).
INSERT INTO system_setting (key, value) VALUES
  ('schedule.breaks', '{"day": {"long": 45, "short": [15, 15, 15]}, "night": {"long": 120, "short": [15, 15, 15]}}'),
  ('schedule.rules', '{"restFactor": 2, "maxConsecutiveDays": 5, "maxShiftHours": 12, "monthNormHours": 168, "normTolerancePct": 10, "breakLateMin": 5}')
ON CONFLICT (key) DO NOTHING;

-- Право на раздел «График работы»: администратор и супервизор.
UPDATE role SET permissions = array_append(permissions, 'schedule.manage')
 WHERE code IN ('admin', 'supervisor') AND NOT ('schedule.manage' = ANY (permissions));
