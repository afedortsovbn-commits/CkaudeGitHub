-- Ф7: шаблоны ответов, база знаний, правила автоответов, провайдеры подсказок (Assist), текстовый бот на канале,
-- оценка чата. Только expand-изменения.
SET lock_timeout = '5s';

-- ---------- Шаблоны ответов (M-AUTO-01): общие и личные, по темам, быстрый вызов «/» ----------
CREATE TABLE IF NOT EXISTS reply_template (
  id            uuid PRIMARY KEY,
  title         text        NOT NULL,
  body          text        NOT NULL,
  -- Быстрый вызов в поле ответа: «/код».
  shortcut      text,
  -- NULL — общий шаблон (ведёт администратор), иначе — личный шаблон сотрудника.
  owner_user_id uuid REFERENCES app_user (id),
  topic_id      uuid REFERENCES topic (id),
  -- Пусто — во всех текстовых каналах.
  channel_kinds text[]      NOT NULL DEFAULT '{}',
  usage_count   integer     NOT NULL DEFAULT 0,
  is_active     boolean     NOT NULL DEFAULT true,
  created_by    uuid REFERENCES app_user (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- Полнотекстовый поиск (русский) для подсказок и поиска в панели оператора (M-AUTO-03).
  search        tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('russian', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('russian', coalesce(body, '')), 'B')
  ) STORED
);
CREATE INDEX IF NOT EXISTS reply_template_search_gin ON reply_template USING gin (search);
CREATE INDEX IF NOT EXISTS reply_template_owner_idx ON reply_template (owner_user_id) WHERE is_active;

-- ---------- База знаний (M-AUTO-05): рубрики и статьи ----------
CREATE TABLE IF NOT EXISTS kb_category (
  id         uuid PRIMARY KEY,
  name       text        NOT NULL,
  parent_id  uuid REFERENCES kb_category (id),
  sort_order integer     NOT NULL DEFAULT 0,
  is_active  boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kb_article (
  id          uuid PRIMARY KEY,
  category_id uuid REFERENCES kb_category (id),
  title       text        NOT NULL,
  body        text        NOT NULL,
  -- Темы обращений, к которым относится статья: подсказка поднимает её выше при совпадении темы.
  topic_ids   uuid[]      NOT NULL DEFAULT '{}',
  -- Дополнительные слова для поиска (синонимы, разговорные формы).
  keywords    text,
  is_active   boolean     NOT NULL DEFAULT true,
  created_by  uuid REFERENCES app_user (id),
  updated_by  uuid REFERENCES app_user (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  search      tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('russian', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('russian', coalesce(keywords, '')), 'A') ||
    setweight(to_tsvector('russian', coalesce(body, '')), 'B')
  ) STORED
);
CREATE INDEX IF NOT EXISTS kb_article_search_gin ON kb_article USING gin (search);
CREATE INDEX IF NOT EXISTS kb_article_topics_gin ON kb_article USING gin (topic_ids);

-- ---------- Правила автоответов (M-AUTO-02) ----------
-- greeting — приветствие при первом сообщении; queued — «вы в очереди»; after_hours — нерабочее время по
-- расписанию; keyword — ответ на ключевые слова (пока обращение ждёт оператора); inactivity — предупреждение и
-- автозакрытие при молчании клиента (params: warnAfterSec, closeAfterSec, closeText).
CREATE TABLE IF NOT EXISTS auto_reply_rule (
  id            uuid PRIMARY KEY,
  name          text        NOT NULL,
  kind          text        NOT NULL CHECK (kind IN ('greeting', 'queued', 'after_hours', 'keyword', 'inactivity')),
  -- Пусто — все текстовые каналы; иначе — только перечисленные экземпляры или типы каналов.
  channel_ids   uuid[]      NOT NULL DEFAULT '{}',
  channel_kinds text[]      NOT NULL DEFAULT '{}',
  schedule_id   uuid REFERENCES schedule (id),
  match_type    text CHECK (match_type IS NULL OR match_type IN ('keyword', 'regex')),
  pattern       text,
  text          text        NOT NULL DEFAULT '',
  params        jsonb       NOT NULL DEFAULT '{}',
  sort_order    integer     NOT NULL DEFAULT 0,
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------- Провайдеры подсказок (Assist API, M-AI-01) ----------
-- builtin — шаблоны и статьи БЗ (FTS PostgreSQL); openai — адаптер к OpenAI-совместимому API (локальный
-- vLLM/Ollama; выключен по умолчанию); http — внешний провайдер по контракту Assist API. Ключ — зашифрован.
CREATE TABLE IF NOT EXISTS assist_provider (
  id               uuid PRIMARY KEY,
  name             text        NOT NULL,
  kind             text        NOT NULL CHECK (kind IN ('builtin', 'openai', 'http')),
  config           jsonb       NOT NULL DEFAULT '{}',
  -- suggest — подсказки в панели; draft — черновик ответа по кнопке.
  functions        text[]      NOT NULL DEFAULT '{suggest}',
  timeout_ms       integer     NOT NULL DEFAULT 1500 CHECK (timeout_ms BETWEEN 100 AND 60000),
  sort_order       integer     NOT NULL DEFAULT 0,
  is_active        boolean     NOT NULL DEFAULT true,
  last_check_at    timestamptz,
  last_check_ok    boolean,
  last_check_error text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
INSERT INTO assist_provider (id, name, kind, functions, sort_order)
VALUES ('00000000-0000-4000-8000-00000000a551', 'Встроенный: шаблоны и база знаний', 'builtin', '{suggest}', 0)
ON CONFLICT (id) DO NOTHING;

-- ---------- Текстовый бот (M-AUTO-04): сценарий flow-engine, назначенный каналу ----------
ALTER TABLE channel ADD COLUMN IF NOT EXISTS bot_flow_id uuid REFERENCES flow (id);
-- Версия сценария бота обращения (публикация новой не влияет на идущие диалоги) и состояние шага.
ALTER TABLE conversation ADD COLUMN IF NOT EXISTS bot_flow_version_id uuid REFERENCES flow_version (id);
ALTER TABLE conversation ADD COLUMN IF NOT EXISTS bot_state jsonb;
-- Дедлайн шага бота (запрос во внешнюю систему): просроченный шаг повторяет любой экземпляр worker.
ALTER TABLE conversation ADD COLUMN IF NOT EXISTS bot_wake_at timestamptz;
CREATE INDEX IF NOT EXISTS conversation_bot_wake_idx ON conversation (bot_wake_at) WHERE bot_wake_at IS NOT NULL;
-- Какие автоответы уже отправлены в обращении и отметка предупреждения о молчании клиента.
ALTER TABLE conversation ADD COLUMN IF NOT EXISTS auto_state jsonb NOT NULL DEFAULT '{}';

-- Служебные признаки сообщения: автоответ/бот, кнопки бота, запрос оценки.
ALTER TABLE message ADD COLUMN IF NOT EXISTS meta jsonb NOT NULL DEFAULT '{}';

-- ---------- Оценка чата (CSAT, M-TEL-09 для текста): одна на обращение ----------
CREATE UNIQUE INDEX IF NOT EXISTS csat_rating_chat_uq ON csat_rating (conversation_id) WHERE call_id IS NULL;
