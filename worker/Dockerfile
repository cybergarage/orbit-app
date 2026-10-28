FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
WORKDIR /opt/worker
COPY package*.json ./
COPY packages ./packages
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
# Install only the lock-pinned SQLite binary; do not run arbitrary dependency hooks.
RUN cd node_modules/better-sqlite3 && node ../prebuild-install/bin.js
COPY entry.mjs models.mjs policy.mjs names.mjs maintenance.mjs sources.mjs ./
ENV HOME=/tmp/worker-home
USER node
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/worker/entry.mjs"]
