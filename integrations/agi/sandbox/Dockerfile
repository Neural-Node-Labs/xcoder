FROM node:20-alpine
RUN apk add --no-cache bash git jq curl python3 py3-yaml shellcheck coreutils findutils grep sed gawk diffutils tar gzip \
 && adduser -D -u 2000 sandbox
COPY server.js /srv/server.js
USER 2000:2000
EXPOSE 9000
CMD ["node", "/srv/server.js"]
