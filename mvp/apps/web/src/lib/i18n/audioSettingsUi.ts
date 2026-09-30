/** Строки интерфейса: раздел «audioSettingsUi» (M-NFR-08). */
export const audioSettingsUi = {
  mikrofonNedostupen: 'Микрофон недоступен: ',
  skazhiteChtoNibudPolosa: 'Скажите что-нибудь — полоса должна двигаться',
  garnituraPodklyuchenaKnopkiOtveta: 'Гарнитура подключена: кнопки ответа, отбоя и микрофона работают',
  garnituraNeVybranaIli:
    'Гарнитура не выбрана или не поддерживает стандартные кнопки телефонии (HID Telephony)',
  nastroykiZvukaIGarnitury: 'Настройки звука и гарнитуры',
  mikrofon: 'Микрофон',
  dinamikRazgovora: 'Динамик разговора',
  proveritDinamik: 'Проверить динамик',
  zvonokRington: 'Звонок (рингтон)',
  proveritZvonok: 'Проверить звонок',
  brauzerNePodderzhivaetVybor:
    'Браузер не поддерживает выбор динамика — звук идёт на устройство по умолчанию.',
  obrabotkaZvuka: 'Обработка звука',
  podavlenieEkha: 'Подавление эха',
  shumopodavlenie: 'Шумоподавление',
  avtousilenie: 'Автоусиление',
  knopkiGarnitury: 'Кнопки гарнитуры',
  podklyuchena: (p0: unknown) => `Подключена: ${p0}`,
  nePodklyuchena: 'Не подключена',
  vybratDruguyu: 'Выбрать другую',
  podklyuchitGarnituru: 'Подключить гарнитуру',
  brauzerNePodderzhivaetWebhid:
    'Браузер не поддерживает WebHID — используйте кнопки в интерфейсе и горячие клавиши.',
  goryachieKlavishiCtrlAlt:
    'Горячие клавиши: Ctrl+Alt+A — ответить, Ctrl+Alt+H — завершить/отклонить, Ctrl+Alt+M — микрофон. Bluetooth-гарнитура при захвате микрофона переходит в режим гарнитуры (узкая полоса) — это нормально; при её отключении звонок продолжится на другом устройстве.',
};
