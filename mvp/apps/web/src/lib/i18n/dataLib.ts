/** Строки интерфейса: раздел «dataLib» (M-NFR-08). */
export const dataLib = {
  estOtkrytyeTikety: (p0: unknown) => `Есть открытые обращения на 2-й линии: ${p0}`,
  pereadresuyteIkhIliNaznachte: (p0: unknown, p1: unknown) =>
    `${p0}${p1} — переадресуйте их или назначьте ответственных (раздел «2-я линия», вкладка «Требуют переназначения»).`,
  required: 'Обязательное поле',
  fillRequired: 'Заполните обязательные поля',
};
