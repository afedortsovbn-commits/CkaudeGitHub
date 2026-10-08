import { apiLib } from './i18n/apiLib';
import { assistPanelUi } from './i18n/assistPanelUi';
import { azsMap } from './i18n/azsMap';
import { audioDevicesLib } from './i18n/audioDevicesLib';
import { audioSettingsUi } from './i18n/audioSettingsUi';
import { authLib } from './i18n/authLib';
import { automation } from './i18n/automation';
import { channels } from './i18n/channels';
import { dataLib } from './i18n/dataLib';
import { demoCall } from './i18n/demoCall';
import { dictPageUi } from './i18n/dictPageUi';
import { flowEditor } from './i18n/flowEditor';
import { integrations } from './i18n/integrations';
import { ivr } from './i18n/ivr';
import { layout } from './i18n/layout';
import { matrix } from './i18n/matrix';
import { mergeContactModalUi } from './i18n/mergeContactModalUi';
import { notificationBellUi } from './i18n/notificationBellUi';
import { org } from './i18n/org';
import { privacy } from './i18n/privacy';
import { callContext } from './i18n/callContext';
import { roles } from './i18n/roles';
import { demoLogin } from './i18n/demoLogin';
import { extApps } from './i18n/extApps';
import { hintPanel } from './i18n/hintPanel';
import { profilePage } from './i18n/profilePage';
import { reports } from './i18n/reports';
import { resources } from './i18n/resources';
import { schedule } from './i18n/schedule';
import { reviews } from './i18n/reviews';
import { settingsPage } from './i18n/settingsPage';
import { softphoneLib } from './i18n/softphoneLib';
import { softphoneUi } from './i18n/softphoneUi';
import { supervisor } from './i18n/supervisor';
import { supervisorNotices } from './i18n/supervisorNotices';
import { tickets } from './i18n/tickets';
import { topics } from './i18n/topics';
import { tree } from './i18n/tree';
import { updateBannerUi } from './i18n/updateBannerUi';
import { users } from './i18n/users';
import { workspace } from './i18n/workspace';
import { wallboard } from './i18n/wallboard';

/** Строки интерфейса. Русский — основной язык; структура позволяет добавить другие (M-NFR-08). */
const ru = {
  appName: 'Контакт-центр',
  login: 'Вход',
  email: 'Email',
  password: 'Пароль',
  signIn: 'Войти',
  signOut: 'Выйти',
  save: 'Сохранить',
  cancel: 'Отмена',
  create: 'Создать',
  add: 'Добавить',
  edit: 'Изменить',
  deactivate: 'Отключить',
  activate: 'Включить',
  active: 'Активна',
  inactive: 'Отключено',
  showInactive: 'Показывать отключённые',
  search: 'Поиск',
  saved: 'Сохранено',
  error: 'Ошибка',
  all: 'Все',
  yes: 'Да',
  no: 'Нет',
  // Ф12: вход со второй ступенью, профиль, неподдерживаемый браузер.
  mfa: {
    code: 'Код из приложения-аутентификатора',
    confirm: 'Подтвердить',
    back: 'Назад',
    setupTitle: 'Настройка входа с кодом',
    setupText:
      'Для администраторов вход с одноразовым кодом обязателен. Отсканируйте QR-код приложением-аутентификатором (FreeOTP, Яндекс Ключ, Google Authenticator) или введите секрет вручную, затем введите код.',
    secret: 'Секрет',
    enabled: 'Вход с кодом включён',
    disabled: 'Вход с кодом выключен',
    enable: 'Включить вход с кодом',
    disable: 'Выключить',
    required: 'Для администраторов обязателен',
  },
  profile: {
    title: 'Профиль',
    changePassword: 'Сменить пароль',
    currentPassword: 'Текущий пароль',
    newPassword: 'Новый пароль (не короче 8 символов)',
    passwordChanged: 'Пароль изменён, другие сессии завершены',
  },
  browser: {
    unsupported:
      'Браузер не поддерживается: гарнитуры и софтфон могут работать неправильно. Используйте Google Chrome, Яндекс Браузер или Microsoft Edge последних версий.',
  },
  nav: {
    home: 'Главная',
    profile: 'Профиль',
    // Группы меню (Ф16): порядок — в lib/nav.ts.
    groupWork: 'Обращения',
    groupApps: 'Приложения',
    groupControl: 'Контроль и отчёты',
    groupChannels: 'Каналы и сценарии',
    groupOrg: 'Оргструктура и справочники',
    groupIntegrations: 'Интеграции и API',
    groupAdmin: 'Администрирование',
    collapse: 'Свернуть меню',
    expand: 'Развернуть меню',
    enterprises: 'Предприятия',
    departments: 'Подразделения',
    topics: 'Темы и поля',
    objects: 'Объекты',
    users: 'Сотрудники',
    matrix: 'Матрица ответственности',
    dictionaries: 'Справочники',
    settings: 'Настройки',
    audit: 'Журнал аудита',
  },
  // Ф11: новая версия интерфейса (M-OP-11).
  update: {
    available: 'Доступна новая версия интерфейса',
    auto: 'Страница обновится сама, когда не будет звонка и неотправленного ответа.',
    autoOff: 'Обновите страницу, когда будет удобно.',
    waitCall: 'Обновление — после завершения звонка',
    waitDraft: 'Есть неотправленный ответ — обновление отложено',
    reloadIn: 'Обновление через',
    reload: 'Обновить',
  },
  release: {
    flags: 'Фиче-флаги',
    log: 'Журнал выпусков',
    tag: 'Версия',
    started: 'Начат',
    duration: 'Длительность',
    status: 'Итог',
  },
  // Разделы страниц и компонентов (Ф12b): lib/i18n/<раздел>.ts.
  apiLib,
  assistPanelUi,
  azsMap,
  audioDevicesLib,
  audioSettingsUi,
  authLib,
  automation,
  channels,
  dataLib,
  demoCall,
  dictPageUi,
  flowEditor,
  integrations,
  ivr,
  layout,
  matrix,
  hintPanel,
  callContext,
  roles,
  demoLogin,
  extApps,
  mergeContactModalUi,
  notificationBellUi,
  org,
  privacy,
  profilePage,
  reports,
  resources,
  schedule,
  settingsPage,
  softphoneLib,
  softphoneUi,
  supervisor,
  supervisorNotices,
  tickets,
  topics,
  tree,
  updateBannerUi,
  users,
  workspace,
  wallboard,
  reviews,
};

export const t = ru;
