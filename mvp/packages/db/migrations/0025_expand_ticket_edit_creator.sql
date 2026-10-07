-- Суть обращения 2-й линии исправляет только оператор, передавший его (решение владельца 07.10.2026):
-- отдельное право tickets.edit (миграция 0024) больше не используется — убрать из ролей.
SET lock_timeout = '5s';
UPDATE role SET permissions = array_remove(permissions, 'tickets.edit') WHERE 'tickets.edit' = ANY (permissions);
