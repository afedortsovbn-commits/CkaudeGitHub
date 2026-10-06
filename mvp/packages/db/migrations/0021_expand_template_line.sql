-- Шаблоны и примеры ответов 2-й линии (п. 18 доработок): отдельно от шаблонов операторов, общие для всех
-- предприятий и подразделений, с привязкой к теме или подтеме. Прежние шаблоны — 1-й линии.
SET lock_timeout = '5s';
ALTER TABLE reply_template ADD COLUMN IF NOT EXISTS line text NOT NULL DEFAULT 'first';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reply_template_line_check') THEN
    ALTER TABLE reply_template ADD CONSTRAINT reply_template_line_check CHECK (line IN ('first', 'second'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS reply_template_second_line_idx ON reply_template (topic_id) WHERE line = 'second' AND is_active;
