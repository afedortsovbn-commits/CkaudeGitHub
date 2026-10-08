/**
 * Общие поля обращения (п. 16 доработок): есть у любого обращения независимо от темы, хранятся в
 * `conversation.fields` под постоянными ключами. Если у темы есть поле с тем же ключом, в карточке оно
 * показывается один раз — в блоке общих полей (с обязательностью из темы).
 */
export const COMMON_FIELD_KEYS = [
  'feedback_channel',
  'company_name',
  'bonus_card',
  'fuel_card',
  'contract_no',
] as const;

export const isCommonField = (key: string) => (COMMON_FIELD_KEYS as readonly string[]).includes(key);
