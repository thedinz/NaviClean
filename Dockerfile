FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    NAVICLEAN_DATA_DIR=/data \
    NAVICLEAN_MUSIC_DIR=/music

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

RUN mkdir -p /data /music \
  && chown -R node:node /data /music /app

USER node
EXPOSE 8080
VOLUME ["/data", "/music"]
CMD ["node", "dist/server/server/index.js"]
