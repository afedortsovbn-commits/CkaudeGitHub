-- Д-101 (16.10.2026): инструкции по разделам программы — текст и видео для каждого пункта меню. Кнопка «?» в шапке
-- открывает инструкцию текущего раздела; нет инструкции — «пока не загружено». Видео и заставка — файлы курсов
-- (course_asset). Только expand-изменения.
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS help_page (
  -- Адрес раздела в меню ('/templates').
  module          text PRIMARY KEY,
  title           text        NOT NULL,
  -- Текст: «## » — заголовок, «- » — пункт списка, **жирный**, пустая строка — новый абзац.
  body            text        NOT NULL DEFAULT '',
  video_asset_id  uuid REFERENCES course_asset (id),
  poster_asset_id uuid REFERENCES course_asset (id),
  updated_by      uuid REFERENCES app_user (id),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
