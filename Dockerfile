FROM node:24-alpine3.24 AS node

FROM node AS dependencies

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM alpine:3.24

WORKDIR /app

RUN apk add --no-cache ca-certificates libstdc++ su-exec \
    && addgroup -g 1000 node \
    && adduser -u 1000 -G node -s /bin/sh -D node

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /app/data \
    && chown node:node /app/data

ENV PORT=7000
ENV DATA_DIR=/app/data
EXPOSE 7000

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
