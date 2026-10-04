-- Этап 2 доработок (п.1 требований заказчика): управление ролями и интерфейс по умолчанию для роли.
-- Роли создаёт администратор («Роли и права»); права — из каталога (packages/auth/src/permissions.ts).
ALTER TABLE role ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE role ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;
-- Интерфейс по умолчанию для сотрудников роли: порядок и видимость пунктов меню, стартовая страница, вкладки
-- рабочего места. NULL — стандартный интерфейс (как раньше).
ALTER TABLE role ADD COLUMN IF NOT EXISTS ui jsonb;
ALTER TABLE role ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE role ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
UPDATE role SET sort_order = CASE code WHEN 'admin' THEN 10 WHEN 'supervisor' THEN 20 WHEN 'operator' THEN 30
                                      WHEN 'responsible' THEN 40 ELSE sort_order END
 WHERE is_system AND sort_order = 0;
