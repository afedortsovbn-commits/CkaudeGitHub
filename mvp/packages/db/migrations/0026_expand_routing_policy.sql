-- Распределение обращений (доработки 07.10.2026): «кто дольше без обращений» — по всем каналам вместе или
-- отдельно по текстовым, голосовым и почте; режим «назначать оператору» или «показывать всем — кто первый взял».
SET lock_timeout = '5s';
ALTER TABLE agent_status ADD COLUMN IF NOT EXISTS last_text_at timestamptz;
ALTER TABLE agent_status ADD COLUMN IF NOT EXISTS last_voice_at timestamptz;
ALTER TABLE agent_status ADD COLUMN IF NOT EXISTS last_email_at timestamptz;
INSERT INTO system_setting (key, value)
VALUES ('routing.policy', '{"text": "auto", "voice": "auto", "email": "auto", "idleScope": "combined"}')
ON CONFLICT (key) DO NOTHING;
