# SIP-периметр Kamailio 6 (02-архитектура 8.1). Пакеты — официальные RPM проекта Kamailio из образа
# kamailio/kamailio-store; ставятся на AlmaLinux 9 без обращения к репозиториям (сборка офлайн, M-NFR-10).
# Kamailio — GPL-2.0, отдельный немодифицированный процесс (В-17).
# syntax=docker/dockerfile:1
ARG KAMAILIO_RPMS_IMAGE=kamailio/kamailio-store:6.0.5-centos-9.amd64
ARG BASE_IMAGE=almalinux:9
FROM ${KAMAILIO_RPMS_IMAGE} AS rpms

FROM ${BASE_IMAGE}
RUN --mount=type=bind,from=rpms,source=/rpms/centos-9/kamailio/RPMS/x86_64,target=/rpms \
    cd /rpms && rpm -i kamailio-6*.x86_64.rpm kamailio-tls-6*.x86_64.rpm kamailio-websocket-6*.x86_64.rpm \
      kamailio-auth-ephemeral-6*.x86_64.rpm kamailio-outbound-6*.x86_64.rpm \
    && mkdir -p /run/kamailio /etc/kamailio/tls
COPY kamailio.cfg dispatcher.list tls.cfg /opt/cc/kamailio/
COPY entrypoint.sh /usr/local/bin/cc-entrypoint.sh
HEALTHCHECK --interval=3s --timeout=3s --start-period=10s --retries=3 \
  CMD kamcmd core.uptime >/dev/null || exit 1
EXPOSE 5060/udp 8443/tcp
ENTRYPOINT ["/usr/local/bin/cc-entrypoint.sh"]
CMD ["kamailio", "-DD", "-E", "-f", "/etc/kamailio/kamailio.cfg"]
