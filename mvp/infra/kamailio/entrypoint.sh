#!/bin/bash
# Конфигурация Kamailio из шаблонов по переменным окружения; самоподписанный сертификат для WSS, если
# свой не смонтирован в /etc/kamailio/tls (на сервере — сертификат домена КЦ).
set -euo pipefail
: "${SIP_SECRET:?укажите SIP_SECRET (общий с api секрет короткоживущих SIP-паролей)}"
SIP_DOMAIN="${SIP_DOMAIN:-cc.local}"
# SIP-транки оператора связи (M-TEL-01, Ф12b): «хост:порт;приоритет» через запятую, 1 — основной (меньше число —
# выше приоритет), без приоритета — по порядку в списке. TRUNK_HOST (один транк) — для совместимости с Ф5–Ф12.
TRUNKS="${TRUNKS:-${TRUNK_HOST:+${TRUNK_HOST};1}}"
# Разрешённые адреса транка: «a.b.c.d, e.f.g.h/24» → подсети через запятую (одиночный адрес — /32). Если список
# задан, к нему добавляются адреса всех транков из TRUNKS (разрешаются при старте).
TRUNK_ALLOW_LIST="${TRUNK_ALLOW:-}"
if [ -n "$TRUNK_ALLOW_LIST" ]; then
  for t in ${TRUNKS//,/ }; do
    h="${t%%;*}"
    h="${h%%:*}"
    ip="$(getent ahostsv4 "$h" 2>/dev/null | awk 'NR==1 {print $1}' || true)"
    if [ -n "$ip" ]; then TRUNK_ALLOW_LIST="${TRUNK_ALLOW_LIST},${ip}"; else echo "TRUNKS: адрес $h не разрешается — не добавлен в TRUNK_ALLOW" >&2; fi
  done
fi
TRUNK_ALLOW="$(echo "$TRUNK_ALLOW_LIST" | tr ', ' '\n\n' | sed '/^$/d; /\//!s/$/\/32/' | sort -u | paste -sd, -)"
# Транки по приоритету (устойчивая сортировка: при равном — по порядку в списке) → «хост:порт|хост:порт…».
TRUNK_LIST=""
i=0
for t in ${TRUNKS//,/ }; do
  i=$((i + 1))
  prio="${t#*;}"
  [ "$prio" = "$t" ] && prio="$i"
  case "$prio" in '' | *[!0-9]*) echo "TRUNKS: неверный приоритет в «$t»" >&2; exit 1 ;; esac
  TRUNK_LIST="${TRUNK_LIST}$(printf '%06d %04d %s' "$prio" "$i" "${t%%;*}")"$'\n'
done
TRUNK_LIST="$(printf '%s' "$TRUNK_LIST" | sed '/^$/d' | sort | awk '{print $3}' | paste -sd'|' -)"
[ -n "$TRUNK_LIST" ] && echo "Транки по приоритету: ${TRUNK_LIST//|/, }"
MEDIA_NODES="${MEDIA_NODES:-asterisk-1:5060 asterisk-2:5060}"
for f in kamailio.cfg tls.cfg; do
  sed -e "s|__SIP_SECRET__|${SIP_SECRET}|g" -e "s|__SIP_DOMAIN__|${SIP_DOMAIN}|g" \
      -e "s#__TRUNK_LIST__#${TRUNK_LIST}#g" -e "s|__TRUNK_ALLOW__|${TRUNK_ALLOW}|g" -e "s|__LISTEN_IF__|${LISTEN_IF:-eth0}|g" \
      -e "s|__SIP_ADVERTISE__|${SIP_ADVERTISE:-kamailio}|g" \
      "/opt/cc/kamailio/$f" > "/etc/kamailio/$f"
done
: > /etc/kamailio/dispatcher.list
for n in $MEDIA_NODES; do echo "1 sip:$n 0 0" >> /etc/kamailio/dispatcher.list; done
if [ ! -s /etc/kamailio/tls/cert.pem ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=${SIP_DOMAIN}" \
    -addext "subjectAltName=DNS:${SIP_DOMAIN},DNS:localhost,IP:127.0.0.1" \
    -keyout /etc/kamailio/tls/key.pem -out /etc/kamailio/tls/cert.pem 2>/dev/null
fi
exec "$@"
