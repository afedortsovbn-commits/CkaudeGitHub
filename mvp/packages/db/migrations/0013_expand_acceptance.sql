-- Ф12: доводка и приёмка MVP — неклассифицированные обращения в правах (В-52), параметры SL (В-51),
-- 2FA администраторов, версии текстов согласий, сроки хранения записей, обезличивание. Только expand-изменения.
SET lock_timeout = '5s';

-- ---------- В-52: «видит неклассифицированные обращения» (без предприятия и темы) ----------
-- У роли — право scope.unclassified; у сотрудника — отметка, важнее роли (NULL — как в ролях).
-- По умолчанию выключено (кроме области «всё» — право scope.all).
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS sees_unclassified boolean;

-- ---------- В-51: параметры расчёта SL («Настройки», без перезапуска) ----------
-- Значения по умолчанию — подтверждённая заказчиком формула: короткие сбросы и возвраты в IVR/бот не входят в
-- знаменатель, каждая постановка в очередь (в т.ч. после перевода) — отдельное поступление, порог — общий.
INSERT INTO system_setting (key, value) VALUES
  ('report.sl_queue_thresholds', '{}'),
  ('report.sl_count_short_abandons', 'false'),
  ('report.sl_count_ivr_returns', 'false'),
  ('report.sl_transfer_new_arrival', 'true')
ON CONFLICT (key) DO NOTHING;

-- ---------- 2FA (TOTP, RFC 6238) — M-NFR-03 ----------
-- Секрет хранится зашифрованным (SECRETS_KEY, как секреты интеграций). pending — выдан, ещё не подтверждён кодом;
-- last_step — шаг последнего принятого кода (повтор того же кода отклоняется).
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS totp_secret text;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS totp_pending_secret text;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS totp_enabled_at timestamptz;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS totp_last_step bigint;
-- Обязательна ли 2FA сотрудникам с административными правами (admin.*). В демо-стенде выключено; в эксплуатации
-- включить в «Настройках» (руководство администратора).
INSERT INTO system_setting (key, value) VALUES ('security.admin_2fa_required', 'false') ON CONFLICT (key) DO NOTHING;

-- ---------- Согласия на обработку ПДн: версии текстов (M-NFR-07, В-16) ----------
-- Каждая версия текста согласия канала сохраняется навсегда: в реестре согласий (`consent`) видно, с каким именно
-- текстом согласился клиент. Изменить текст без новой версии нельзя.
CREATE TABLE IF NOT EXISTS consent_text (
  id         uuid PRIMARY KEY,
  channel_id uuid        NOT NULL REFERENCES channel (id),
  version    text        NOT NULL,
  text       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, version)
);

CREATE OR REPLACE FUNCTION channel_consent_text() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v text := COALESCE(NULLIF(NEW.config ->> 'consent_version', ''), '1');
  t text := COALESCE(NULLIF(NEW.config ->> 'consent_text', ''), 'Я согласен(на) на обработку персональных данных.');
  prev text;
BEGIN
  IF NEW.kind NOT IN ('webchat', 'app') THEN
    RETURN NEW;
  END IF;
  SELECT ct.text INTO prev FROM consent_text ct WHERE ct.channel_id = NEW.id AND ct.version = v;
  IF prev IS NULL THEN
    INSERT INTO consent_text (id, channel_id, version, text) VALUES (gen_random_uuid(), NEW.id, v, t);
  ELSIF prev <> t THEN
    RAISE EXCEPTION 'Текст согласия изменён — укажите новую версию (версия % уже использована)', v;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER channel_consent_text_trg AFTER INSERT OR UPDATE OF config, kind ON channel
  FOR EACH ROW EXECUTE FUNCTION channel_consent_text();

-- Действующие тексты каналов на момент выпуска.
INSERT INTO consent_text (id, channel_id, version, text)
SELECT gen_random_uuid(), c.id, COALESCE(NULLIF(c.config ->> 'consent_version', ''), '1'),
       COALESCE(NULLIF(c.config ->> 'consent_text', ''), 'Я согласен(на) на обработку персональных данных.')
  FROM channel c WHERE c.kind IN ('webchat', 'app')
ON CONFLICT (channel_id, version) DO NOTHING;
CREATE INDEX IF NOT EXISTS consent_accepted_idx ON consent (accepted_at);

-- ---------- Сроки хранения и обезличивание (M-NFR-07, M-ADM-01) ----------
-- Удалённые по сроку хранения (или при обезличивании клиента) записи разговоров и вложения: строка остаётся для
-- истории и отчётов, файл в хранилище удалён.
ALTER TABLE call_recording ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE attachment ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS call_recording_retention_idx ON call_recording (created_at) WHERE deleted_at IS NULL;
ALTER TABLE contact ADD COLUMN IF NOT EXISTS anonymized_at timestamptz;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS anonymized_at timestamptz;

-- Журнал событий неизменяем, кроме одного случая: обезличивание клиента стирает тексты его сообщений и
-- контактные данные в событиях (UPDATE в транзакции с `SET LOCAL cc.pd_erase = 'on'`). Удаление — никогда;
-- журнал аудита неизменяем всегда.
CREATE OR REPLACE FUNCTION event_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'event' AND current_setting('cc.pd_erase', true) = 'on' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'журнал событий неизменяем (append-only)';
END;
$$;
