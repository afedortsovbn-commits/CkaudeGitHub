-- Доработки 06.10.2026 (2-я линия): право редактирования сути обращения и отметка «просмотрено» сотрудником.
SET lock_timeout = '5s';
-- Редактирование сути — отдельное право; по умолчанию только у администратора.
UPDATE role SET permissions = array_append(permissions, 'tickets.edit')
 WHERE code = 'admin' AND NOT ('tickets.edit' = ANY (permissions));
-- «Новое» в списке: обращение, которое сотрудник ещё ни разу не открывал.
CREATE TABLE IF NOT EXISTS ticket_view (
  ticket_id     uuid        NOT NULL REFERENCES ticket (id),
  user_id       uuid        NOT NULL REFERENCES app_user (id),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_id, user_id)
);
CREATE INDEX IF NOT EXISTS ticket_view_user_idx ON ticket_view (user_id);
