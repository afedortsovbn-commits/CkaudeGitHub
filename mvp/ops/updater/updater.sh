#!/usr/bin/env bash
# Служба обновления (Д-065). Каждые 5 с отмечается в БД (system_updater) и берёт подтверждённое администратором
# обновление (system_update.status = 'queued'). Шаги — с журналом в system_update.log (видно в интерфейсе):
#   1) распаковка файла и проверка контрольных сумм; 2) резервная копия БД и файлов (ops/backup.sh);
#   3) загрузка образов (docker load); 4) файлы развёртывания (infra/, ops/) — с копией прежних;
#   5) выпуск без остановки обработки обращений (ops/release.sh <версия>) — миграции expand, поэтапная замена.
# Переменные: DATABASE_URL; DEPLOY_DIR (каталог развёртывания, тот же путь, что на сервере); UPDATES_DIR (/updates);
# UPDATER_DRY_RUN=true — пробный режим (демо-стенд): шаги 2, 4, 5 только описываются, систему не меняют.
set -uo pipefail
DEPLOY_DIR="${DEPLOY_DIR:-/deploy}"
UPDATES_DIR="${UPDATES_DIR:-/updates}"
DRY="${UPDATER_DRY_RUN:-false}"
export COMPOSE_FILE="${COMPOSE_FILE:-$DEPLOY_DIR/infra/compose/docker-compose.yml}"

q() { psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -qtAX "$@"; }
# SQL со значениями через переменные psql (:'имя') — без подстановки текста в запрос.
sqlv() { local sql="$1"; shift; printf '%s\n' "$sql" | q "$@"; }

ID=""
log() {
  echo "[updater] $*"
  [ -n "$ID" ] && sqlv "UPDATE system_update SET log = log || :'line' || E'\n' WHERE id = :'id'" \
    -v id="$ID" -v line="$(date +%H:%M:%S) $*" >/dev/null
}
step() {
  log "== $*"
  sqlv "UPDATE system_update SET step = :'s' WHERE id = :'id'" -v id="$ID" -v s="$*" >/dev/null
}
# Вывод команды — построчно в журнал.
pipe() { while IFS= read -r line; do log "  $line"; done; }
finish() {
  local status="$1" err="${2:-}"
  sqlv "UPDATE system_update SET status = :'st', finished_at = now(), error = NULLIF(:'err', ''),
          step = CASE WHEN :'st' = 'done' THEN 'Готово' ELSE 'Ошибка' END WHERE id = :'id'" \
    -v id="$ID" -v st="$status" -v err="$err" >/dev/null
}

run() {
  local W="$UPDATES_DIR/$ID" F="$UPDATES_DIR/$ID.ccupd"
  step "Распаковка и проверка файла"
  rm -rf "$W" && mkdir -p "$W"
  tar -xf "$F" -C "$W" || { finish failed "Файл обновления не распаковывается"; return; }
  local M="$W/manifest.json"
  local VERSION; VERSION="$(jq -r .version "$M")"
  local PREV; PREV="$(docker compose ps -q api 2>/dev/null | head -1 | xargs -r docker inspect -f '{{.Config.Image}}' | sed 's/.*://')"
  log "версия: ${PREV:-?} → $VERSION$([ "$DRY" = true ] && echo ' (пробный режим)')"
  for part in images deploy; do
    local file sum
    file="$(jq -r ".$part.file // empty" "$M")"
    [ -z "$file" ] && continue
    sum="$(sha256sum "$W/$file" | cut -d' ' -f1)"
    if [ "$sum" != "$(jq -r ".$part.sha256" "$M")" ]; then
      finish failed "Контрольная сумма $file не совпадает — файл повреждён, загрузите его заново"
      return
    fi
    log "контрольная сумма $file — верна"
  done

  step "Резервная копия базы и файлов"
  if [ "$DRY" = true ]; then
    log "пробный режим: ops/backup.sh не запускается"
  else
    (cd "$DEPLOY_DIR" && KEEP="${BACKUP_KEEP:-5}" bash ops/backup.sh 2>&1) | pipe
    [ "${PIPESTATUS[0]}" = 0 ] || { finish failed "Резервная копия не сделана — обновление не начато"; return; }
  fi

  local images; images="$(jq -r '.images.file // empty' "$M")"
  if [ -n "$images" ]; then
    step "Загрузка образов"
    gunzip -c "$W/$images" | docker load 2>&1 | pipe
    [ "${PIPESTATUS[1]}" = 0 ] || { finish failed "Образы не загрузились"; return; }
  fi

  local deploy; deploy="$(jq -r '.deploy.file // empty' "$M")"
  if [ -n "$deploy" ]; then
    step "Файлы развёртывания"
    if [ "$DRY" = true ]; then
      log "пробный режим: файлы не заменяются; в обновлении — $(tar -tzf "$W/$deploy" | wc -l) файлов"
    else
      tar -czf "$W/deploy-before.tar.gz" -C "$DEPLOY_DIR" infra ops 2>/dev/null
      log "прежние infra/ и ops/ сохранены: $W/deploy-before.tar.gz"
      tar -xzf "$W/$deploy" -C "$DEPLOY_DIR" 2>&1 | pipe
    fi
  fi

  step "Обновление сервисов (без остановки обработки обращений)"
  local services start flags media
  services="$(jq -r '.release.services // [] | join(" ")' "$M")"
  start="$(jq -r '.release.startServices // [] | join(" ")' "$M")"
  flags="$(jq -r '.release.featureFlags // [] | join(",")' "$M")"
  media="$(jq -r '.release.mediaTag // empty' "$M")"
  if [ -z "$services" ]; then
    log "сервисы в этом обновлении не меняются"
  elif [ "$DRY" = true ]; then
    log "пробный режим: ops/release.sh $VERSION не запускается (сервисы: $services)"
  else
    (cd "$DEPLOY_DIR" && SERVICES="$services" START_SERVICES="$start" FEATURE_FLAGS="$flags" MEDIA_TAG="$media" \
      SKIP_COMPAT=1 bash ops/release.sh "$VERSION" 2>&1) | pipe
    if [ "${PIPESTATUS[0]}" != 0 ]; then
      finish failed "Выпуск остановлен на ошибке; работающие экземпляры остались прежними. Откат: ops/release.sh --rollback ${PREV:-<прежняя версия>}"
      return
    fi
  fi
  rm -f "$F"
  log "обновление завершено"
  finish done
}

echo "[updater] служба обновления запущена (пробный режим: $DRY)"
# Файлы обновления принимает api (пользователь node, uid 1000) — каталог тома должен быть ему доступен.
mkdir -p "$UPDATES_DIR" && chown "${APP_UID:-1000}:${APP_UID:-1000}" "$UPDATES_DIR"
# Обновление, прерванное перезапуском службы, — ошибка: состояние нужно проверить вручную.
sqlv "UPDATE system_update SET status = 'failed', finished_at = now(), step = 'Ошибка',
        error = 'Служба обновления перезапустилась во время обновления — проверьте состояние системы' WHERE status = 'running'" \
  >/dev/null 2>&1 || true
while true; do
  sqlv "INSERT INTO system_updater (id, seen_at, info) VALUES (1, now(), jsonb_build_object('dryRun', :'dry' = 'true'))
        ON CONFLICT (id) DO UPDATE SET seen_at = now(), info = excluded.info" -v dry="$DRY" >/dev/null 2>&1 || true
  ID="$(q -c "UPDATE system_update SET status = 'running', started_at = now(), step = 'Подготовка'
               WHERE id = (SELECT id FROM system_update WHERE status = 'queued' ORDER BY confirmed_at LIMIT 1)
               RETURNING id" 2>/dev/null || true)"
  if [ -n "$ID" ]; then
    run
    ID=""
  fi
  sleep 5
done
