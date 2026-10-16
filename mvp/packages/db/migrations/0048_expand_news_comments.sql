-- Д-100 (16.10.2026): модерация комментариев к новостям (мобильные сервисы m.belorusneft.by). Публичный канал:
-- комментарии и ответы видят все читатели новости. Сайт присылает комментарий по ключу API (право «comments»),
-- модератор (оператор) публикует, отклоняет с причиной или отвечает от имени компании; решения сайт получает
-- webhook-событием comment.moderated или запросом списка решений. Только expand-изменения.
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS news_comment (
  id                 uuid PRIMARY KEY,
  source             text        NOT NULL DEFAULT 'm.belorusneft.by',
  api_key_id         uuid REFERENCES api_key (id),
  external_id        text,
  news_id            text        NOT NULL,
  news_title         text        NOT NULL DEFAULT '',
  news_url           text,
  parent_id          uuid REFERENCES news_comment (id),
  author_name        text        NOT NULL DEFAULT '',
  author_external_id text,
  -- Ответ компании (пишет модератор): публикуется сразу.
  is_official        boolean     NOT NULL DEFAULT false,
  body               text        NOT NULL,
  status             text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reject_reason      text,
  moderated_by       uuid REFERENCES app_user (id),
  moderated_at       timestamptz,
  posted_at          timestamptz NOT NULL DEFAULT now(),
  received_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS news_comment_ext_uq ON news_comment (source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS news_comment_status_idx ON news_comment (status, received_at);
CREATE INDEX IF NOT EXISTS news_comment_moderated_idx ON news_comment (moderated_at) WHERE moderated_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS news_comment_parent_idx ON news_comment (parent_id) WHERE parent_id IS NOT NULL;

-- Право «Модерация комментариев» — администратору, супервизору и операторам.
UPDATE role SET permissions = array_append(permissions, 'moderation.work')
 WHERE code IN ('admin', 'supervisor', 'operator') AND NOT ('moderation.work' = ANY (permissions));
