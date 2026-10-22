# Briarflow server + studio in one image.
#
#   docker build -t briarflow .
#   docker run -p 3000:3000 -v briarflow-data:/data briarflow
#   docker run -p 3000:3000 -e ANTHROPIC_API_KEY=sk-ant-... briarflow   # adds the Claude nodes
#
# The server runs the TypeScript sources with tsx (no separate bundle step).

# ---- build: install everything, build the studio, then drop dev dependencies ----
FROM node:20-bookworm-slim AS build
# better-sqlite3 falls back to compiling from source when no prebuilt binary matches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN npm ci --no-audit --no-fund \
 && npm run build -w @briarflow/studio \
 && npm prune --omit=dev --no-audit --no-fund

# ---- runtime ----
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    BRIAR_DATA_DIR=/data
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--import", "tsx", "apps/server/src/main.ts"]
