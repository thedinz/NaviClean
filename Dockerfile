FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    PUID=1000 \
    PGID=1000 \
    NAVICLEAN_DATA_DIR=/data \
    NAVICLEAN_MUSIC_DIR=/music

WORKDIR /app
COPY package*.json ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends gosu \
  && rm -rf /var/lib/apt/lists/* \
  && npm ci --omit=dev \
  && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /data /music \
  && chown -R node:node /data /music /app \
  && chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 8080
VOLUME ["/data", "/music"]
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/server/server/index.js"]
