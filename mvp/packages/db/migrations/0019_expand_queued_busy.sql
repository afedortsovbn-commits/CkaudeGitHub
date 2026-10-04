-- Этап 1 доработок (п.4 требований заказчика): «Все операторы заняты» — отдельное правило автоответа чата.
-- Шлётся вместо «Вы в очереди», если в очереди обращения нет ни одного свободного оператора.
-- Расширение набора допустимых значений совместимо с предыдущей версией (она его не порождает).
ALTER TABLE auto_reply_rule DROP CONSTRAINT IF EXISTS auto_reply_rule_kind_check;
ALTER TABLE auto_reply_rule ADD CONSTRAINT auto_reply_rule_kind_check
  CHECK (kind IN ('greeting', 'queued', 'queued_busy', 'after_hours', 'keyword', 'inactivity')) NOT VALID;
