# pimon-hub: the A2A hub. Build: podman build --format docker -f Containerfile -t pimon-hub .
FROM docker.io/library/node:24-slim@sha256:0e2646ab57e77b7a384a0cb59b6815b182c77e1f9c3ba36bd8435bd9c4e6680e

# GitHub links the ghcr.io package to this repository through the source label, so the workflow token may push it.
LABEL org.opencontainers.image.source="https://github.com/orswn/pimon" \
	org.opencontainers.image.description="pimon-hub: A2A message hub for pi sessions"

WORKDIR /app
ENV NODE_ENV=production \
	NODE_OPTIONS=--disable-warning=ExperimentalWarning \
	HUB_DATA=/data

COPY package.json package-lock.json ./
# The extension's peer dependencies are pi itself. The hub does not import them.
RUN npm ci --omit=dev --omit=peer --ignore-scripts && npm cache clean --force

COPY src/hub ./src/hub
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 8080
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD ["node", "-e", "const l = process.env.HUB_LISTEN || '0.0.0.0:8080'; fetch('http://127.0.0.1:' + l.slice(l.lastIndexOf(':') + 1) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "src/hub/main.ts"]
