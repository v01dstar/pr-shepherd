# pr-shepherd runtime (DESIGN §12): Node 22, git, gh, python3, and a Go toolchain for target repos.
# Build args:
#   GO_VERSION          Go toolchain to install into /usr/local/go; set it empty (--build-arg GO_VERSION=) to skip Go.
#   EXTRA_APT_PACKAGES  space-separated Debian packages the target repos need (e.g. "make build-essential").
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ARG GO_VERSION=1.25.1
ARG EXTRA_APT_PACKAGES=""
LABEL org.opencontainers.image.source="https://github.com/v01dstar/pr-shepherd" \
      org.opencontainers.image.title="pr-shepherd" \
      org.opencontainers.image.description="Slack bot that shepherds GitHub PRs through reviews, on the Claude Agent SDK" \
      org.opencontainers.image.licenses="MIT"
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl gnupg openssh-client jq python3 \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh ${EXTRA_APT_PACKAGES} \
 && if [ -n "${GO_VERSION}" ]; then curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-$(dpkg --print-architecture).tar.gz" | tar -C /usr/local -xz; fi \
 && rm -rf /var/lib/apt/lists/*
ENV PATH=/usr/local/go/bin:$PATH \
    DATA_DIR=/data \
    CLAUDE_CONFIG_DIR=/data/claude \
    NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
COPY .claude-plugin ./.claude-plugin
COPY skills ./skills
RUN git config --system init.defaultBranch main
# Starts as root only to fix /data ownership, then drops to the non-root `node` user (see the script).
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
