#!/bin/bash
# Конфигурация Kamailio из шаблонов по переменным окружения; самоподписанный сертификат для WSS, если
# свой не смонтирован в /etc/kamailio/tls (на сервере — сертификат домена КЦ).
set -euo pipefail
: "${SIP_SECRET:?укажите SIP_SECRET (общий с api секрет короткоживущих SIP-паролей)}"
SIP_DOMAIN="${SIP_DOMAIN:-cc.local}"
TRUNK_HOST="${TRUNK_HOST:-}"
# Разрешённые адреса транка: «a.b.c.d, e.f.g.h/24» → подсети через запятую (одиночный адрес — /32).
TRUNK_ALLOW="$(echo "${TRUNK_ALLOW:-}" | tr ', ' '\n\n' | sed '/^$/d; /\//!s/$/\/32/' | paste -sd, -)"
MEDIA_NODES="${MEDIA_NODES:-asterisk-1:5060 asterisk-2:5060}"
for f in kamailio.cfg tls.cfg; do
  sed -e "s|__SIP_SECRET__|${SIP_SECRET}|g" -e "s|__SIP_DOMAIN__|${SIP_DOMAIN}|g" \
      -e "s|__TRUNK_HOST__|${TRUNK_HOST}|g" -e "s|__TRUNK_ALLOW__|${TRUNK_ALLOW}|g" -e "s|__LISTEN_IF__|${LISTEN_IF:-eth0}|g" \
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
