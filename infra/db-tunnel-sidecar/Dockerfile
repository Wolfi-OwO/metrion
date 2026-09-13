FROM alpine:3.20
RUN apk add --no-cache openssh-client autossh
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
