# Canvass: one image, two processes (backend spec §2). docker-compose.yml runs it as `web` and `worker`.
FROM node:24-bookworm-slim AS build
WORKDIR /app
# Toolchain in case a native module (better-sqlite3, argon2) has no prebuilt binary for this platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci
COPY . .
RUN npx next build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    DATABASE_URL=file:/data/canvass.db \
    UPLOAD_DIR=/data/uploads \
    NEXT_TELEMETRY_DISABLED=1
# The worker runs TypeScript through tsx, and migrations need the Prisma CLI, so the image keeps the
# source and the full node_modules.
COPY --from=build /app ./
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && npx tsx prisma/seed.ts && npx next start -p 3000"]
