# Узел медиасервера Asterisk 22 LTS (PJSIP, WebRTC, ARI). Базовый образ собран из исходников Asterisk
# (GPL-2.0, используется как отдельный немодифицированный процесс — В-17). Сборка не скачивает ничего.
ARG ASTERISK_IMAGE=andrius/asterisk:22
FROM ${ASTERISK_IMAGE}
COPY conf/ /opt/cc/asterisk/
COPY moh/default.wav /var/lib/asterisk/moh/default.wav
COPY entrypoint.sh /usr/local/bin/cc-entrypoint.sh
ENV ASTERISK_TERMINAL_OPTS="-n"
HEALTHCHECK --interval=3s --timeout=3s --start-period=20s --retries=3 \
  CMD asterisk -rx "core show uptime" | grep -q "System uptime" || exit 1
ENTRYPOINT ["/usr/local/bin/cc-entrypoint.sh"]
CMD ["/usr/sbin/asterisk", "-f", "-W", "-U", "asterisk", "-p"]
