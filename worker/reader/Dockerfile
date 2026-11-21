FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS dependencies
WORKDIR /reader
COPY reader/package.json reader/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
LABEL org.cybergarage.orbit-app.workspace-reader-standalone="1"
WORKDIR /opt/worker
COPY --from=dependencies /reader/node_modules ./node_modules
COPY workspace-reader.mjs policy.mjs ./
ENV HOME=/tmp/reader-home
USER node
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/node", "/opt/worker/workspace-reader.mjs"]
