-- Д-095 (16.10.2026): фото сотрудника (справочник «Сотрудники») — показывается клиенту в чате на сайте, пока этот
-- сотрудник ведёт переписку. Сам файл — в хранилище файлов (S3), здесь ключ и время замены. Только expand-изменения.
SET lock_timeout = '5s';

ALTER TABLE app_user ADD COLUMN IF NOT EXISTS photo_key text;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS photo_content_type text;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS photo_updated_at timestamptz;
