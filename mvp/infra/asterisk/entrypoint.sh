#!/bin/bash
# Конфигурация узла генерируется из шаблонов (одинаковых для всех узлов) по переменным окружения.
set -euo pipefail
: "${NODE_NAME:?укажите NODE_NAME (asterisk-1, asterisk-2)}"
: "${ARI_PASSWORD:?укажите ARI_PASSWORD}"
RTP_START="${RTP_START:-10000}"
RTP_END="${RTP_END:-10099}"
EXTERNAL=""
if [ -n "${EXTERNAL_ADDRESS:-}" ]; then
  EXTERNAL="external_media_address = ${EXTERNAL_ADDRESS}"
fi
for f in /opt/cc/asterisk/*.conf; do
  sed -e "s|__NODE_NAME__|${NODE_NAME}|g" \
      -e "s|__ARI_PASSWORD__|${ARI_PASSWORD}|g" \
      -e "s|__RTP_START__|${RTP_START}|g" \
      -e "s|__RTP_END__|${RTP_END}|g" \
      -e "s|__EXTERNAL_ADDRESS__|${EXTERNAL}|g" \
      "$f" > "/etc/asterisk/$(basename "$f")"
done
rm -f /etc/asterisk/users.conf /etc/asterisk/sip.conf
mkdir -p /var/spool/asterisk/recording /var/cache/asterisk
chown asterisk:asterisk /var/cache/asterisk
exec /usr/local/bin/entrypoint.sh "$@"
