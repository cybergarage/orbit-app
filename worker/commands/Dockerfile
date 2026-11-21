FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
RUN install -d -m 0555 /opt/orbit-index-view /opt/orbit-index-view/objects \
      /opt/orbit-index-view/refs /opt/orbit-index-view/refs/heads \
    && printf 'ref: refs/heads/main\n' > /opt/orbit-index-view/HEAD \
    && chmod 0444 /opt/orbit-index-view/HEAD
COPY command.mjs /opt/orbit-command.mjs
ENV HOME=/tmp
USER node
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/node", "/opt/orbit-command.mjs"]
