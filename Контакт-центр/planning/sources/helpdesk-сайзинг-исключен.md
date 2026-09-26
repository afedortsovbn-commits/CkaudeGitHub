# HelpDesk: сайзинг — исключён

Источник: `Сайзинг_инфраструктуры_—Helpdesk.pdf` (45 стр., «OCP Helpdesk Self-hosted Edition»).

**Что в документе:** копия структуры OCP-документа: конфигурации по тикетам/мес, vCPU/RAM/диски, сеть, SSL, бэкапы, обновления, чек-лист DevOps.

**Почему исключён:** ≈90% — сайзинг и инфраструктура, которые заказчик велел отбросить. Функциональности 2-й линии (эскалация, согласование закрытия, возврат на доработку) документ не описывает.

## Полезные факты о составе HelpDesk (не железо)
- Стек **Supabase**: 9 контейнеров — PostgreSQL 15 (pg_cron, pg_net), Kong (API Gateway), GoTrue (auth, JWT), PostgREST (автогенерируемый REST), Realtime (WebSocket-подписки), Storage API, **Edge Functions на Deno (60+ функций)**, Studio (админка БД, в prod отключать), Frontend (React SPA). Маршрутизация: Nginx → `/app/*` Frontend, `/api/*` Kong.
- Сущности БД: tickets, ticket_comments, ticket_communications, sla_events, ticket_history (аудит), ticket_custom_field_values, ticket_tags, comment_files, comment_reads, comment_emails; clients, companies, automations, FTS (GIN).
- Потоки: комментарий → Functions → PostgreSQL → Realtime → клиент; **email — основной входящий канал** (IMAP-поллинг по pg_cron → `email-processor` → новый тикет/комментарий/вложение); автоматизации: триггер БД → pg_net → Kong → `automation-engine`; SLA-проверка по cron (`sla-check`); **клиентский портал (PWA)** → `client-portal-*`; уведомления по SMTP.
- Опционально: LLM API, Telegram, WhatsApp (через functions).
- HA/обновления — как в OCP (sticky WS для Realtime, rolling update).
- [прим.] HelpDesk — отдельный продукт на другом стеке, чем OCP; интеграция OCP↔HelpDesk в документе не описана.
