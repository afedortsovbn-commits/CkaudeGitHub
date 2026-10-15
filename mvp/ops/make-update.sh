#!/usr/bin/env bash
# Файл обновления для установки из интерфейса («Система → Обновление системы», Д-065).
#   ops/make-update.sh <версия> <описание.json> [ревизия прежнего выпуска]
# <версия> — тег собранных образов (ops/build-images.sh <версия>); <описание.json> — что меняется, для администратора:
#   { "title": "…", "fromVersions": ["…"], "changes": [{"id": "Д-061", "title": "…", "important": false}],
#     "warnings": [{"level": "warning", "text": "…"}], "stopsIntake": false, "intakeStopMinutes": 0,
#     "release": {"services": ["api", "web"], "startServices": [], "featureFlags": [], "mediaTag": null},
#     "blocks": [ … необязательно: свои описания блоков ] }
# Без "release.services" — все прикладные сервисы. Блоки (что останавливается и на сколько) по умолчанию —
# из состава выпуска: прикладные сервисы меняются поэтапно без простоя (ops/rollout.sh), медиа — с осушением.
# Миграции — новые файлы packages/db/migrations с ревизии прежнего выпуска (по умолчанию последний тег release-*).
# Результат: out/updates/cc-update-<версия>.ccupd (tar: manifest.json, images.tar.gz, deploy.tar.gz).
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="${1:?укажите версию (тег образов)}"
SRC="${2:?укажите файл описания обновления (json)}"
BASE="${3:-$(git describe --tags --abbrev=0 --match 'release-*' 2>/dev/null || echo '')}"
OUT="out/updates"
W="$(mktemp -d)"
trap 'rm -rf "$W"' EXIT
mkdir -p "$OUT"

ALL="connector-telegram connector-email connector-rocketdata worker router realtime api call-control web"
SERVICES="$(jq -r '.release.services // [] | join(" ")' "$SRC")"
SERVICES="${SERVICES:-$ALL}"
MEDIA="$(jq -r '.release.mediaTag // empty' "$SRC")"

images=()
for s in $SERVICES; do images+=("cc/$s:$VERSION"); done
if [ -n "$MEDIA" ]; then images+=("cc/asterisk:$MEDIA"); fi
docker image inspect "cc/updater:$VERSION" >/dev/null 2>&1 && images+=("cc/updater:$VERSION")
for i in "${images[@]}"; do
  docker image inspect "$i" >/dev/null 2>&1 || { echo "нет образа $i — соберите: ops/build-images.sh $VERSION"; exit 1; }
done
echo "образы: ${images[*]}"
docker save "${images[@]}" | gzip -1 > "$W/images.tar.gz"
# Файлы развёртывания — из зафиксированной ревизии (без .env и локальных файлов).
git archive HEAD infra ops docs | gzip -9 > "$W/deploy.tar.gz"

MIGRATIONS="[]"
if [ -n "$BASE" ]; then
  MIGRATIONS="$(git diff --name-only --diff-filter=A "$BASE" HEAD -- packages/db/migrations | xargs -r -n1 basename | jq -R . | jq -s .)"
fi

# Блоки по умолчанию: что происходит с каждым сервисом выпуска.
blocks() {
  for s in $SERVICES; do
    case "$s" in
      api) t='API и интерфейс сотрудников'; n='Экземпляры заменяются по одному — запросы обслуживают оставшиеся' ;;
      web) t='Интерфейс сотрудников (страницы)'; n='Открытые вкладки предложат обновиться — вне звонка и без потери черновика' ;;
      worker) t='Фоновые задачи (почта 2-й линии, напоминания, контроль ресурсов)'; n='Задачи продолжат работу после замены экземпляров' ;;
      router) t='Распределение обращений'; n='Очередь сохраняется в базе; распределение продолжается с другим экземпляром' ;;
      realtime) t='Обновления экранов (WebSocket)'; n='Экраны переподключатся автоматически за 1–3 секунды' ;;
      call-control) t='Управление звонками'; n='Текущие звонки не прерываются, новые принимает второй экземпляр' ;;
      connector-telegram) t='Канал Telegram'; n='Сообщения, пришедшие во время замены, будут доставлены после неё' ;;
      connector-email) t='Канал e-mail'; n='Письма забираются из ящика после замены — не теряются' ;;
      connector-rocketdata) t='Отзывы с карт (Rocket Data)'; n='Отзывы забираются по расписанию — не теряются' ;;
      *) t="$s"; n='' ;;
    esac
    jq -n --arg name "$s" --arg title "$t" --arg note "$n" \
      '{name: $name, title: $title, effect: "rolling", downtimeSeconds: 0, stopsIntake: false, note: $note}'
  done
  if [ -n "$MEDIA" ]; then
    jq -n '{name: "asterisk", title: "Медиасервер звонков", effect: "rolling", downtimeSeconds: 0, stopsIntake: false,
            note: "Узлы обновляются по одному после завершения разговоров на них (осушение)"}'
  fi
}
DEFAULT_BLOCKS="$(blocks | jq -s .)"
sha() { sha256sum "$1" | cut -d' ' -f1; }
size() { stat -c %s "$1"; }

jq -n --slurpfile src "$SRC" --arg version "$VERSION" --arg created "$(date -Iseconds)" \
  --argjson blocks "$DEFAULT_BLOCKS" --argjson migrations "$MIGRATIONS" --arg services "$SERVICES" \
  --arg isha "$(sha "$W/images.tar.gz")" --argjson isize "$(size "$W/images.tar.gz")" \
  --arg dsha "$(sha "$W/deploy.tar.gz")" --argjson dsize "$(size "$W/deploy.tar.gz")" '
  $src[0] as $s
  | {
      format: "cc-update/1", version: $version, createdAt: $created,
      title: ($s.title // ("Обновление " + $version)),
      fromVersions: ($s.fromVersions // []),
      stopsIntake: ($s.stopsIntake // false), intakeStopMinutes: ($s.intakeStopMinutes // 0),
      durationMinutes: ($s.durationMinutes // (($services | split(" ") | length) * 2 + 5)),
      changes: ($s.changes // []), warnings: ($s.warnings // []),
      blocks: ($s.blocks // $blocks), migrations: ($s.migrations // $migrations),
      release: (($s.release // {}) + {services: ($services | split(" "))}),
      images: {file: "images.tar.gz", sha256: $isha, size: $isize},
      deploy: {file: "deploy.tar.gz", sha256: $dsha, size: $dsize}
    }' > "$W/manifest.json"

F="$OUT/cc-update-$VERSION.ccupd"
tar --format=ustar -cf "$F" -C "$W" manifest.json images.tar.gz deploy.tar.gz
echo "готово: $F ($(du -h "$F" | cut -f1))"
jq '{version, title, stopsIntake, durationMinutes, changes: (.changes | length), blocks: [.blocks[].name], migrations}' "$W/manifest.json"
