-- Д-033 (cctest 5.2): срок ответа 2-й линии по умолчанию — 5 дней (было 15), если администратор его не менял.
SET lock_timeout = '5s';

UPDATE system_setting SET value = '5'::jsonb WHERE key = 'ticket.default_response_days' AND value = '15'::jsonb;
