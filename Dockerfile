FROM oven/bun:1 AS build
WORKDIR /app

# Install root deps
COPY package.json bun.lock* ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/site/package.json apps/site/
COPY packages/cli/package.json packages/cli/
COPY packages/mcp/package.json packages/mcp/
RUN bun install --frozen-lockfile --ignore-scripts

# Build client
COPY apps/web/ apps/web/
COPY tsconfig.json .
RUN cd apps/web && bun run build

# Production stage
FROM oven/bun:1-slim
WORKDIR /app

# git is required by the source-credentials check endpoint (#111),
# which shells out to `git ls-remote` to verify HTTPS PAT access
# against a private repo before any deploy attempts. The slim base
# image does not include git.
#
# ca-certificates is a Recommends of git on Debian, not a Depends, so
# --no-install-recommends skips it. Without it, every HTTPS git
# operation fails TLS verification ("server certificate verification
# failed. CAfile: none CRLfile: none") and /check returns git_error.
# Surfaced by the 0.45.0 deploy smoke; install explicitly.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock* ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/site/package.json apps/site/
COPY packages/cli/package.json packages/cli/
COPY packages/mcp/package.json packages/mcp/
RUN bun install --frozen-lockfile --ignore-scripts --production

# Copy built client and server source
COPY --from=build /app/apps/web/dist apps/web/dist
COPY apps/api/ apps/api/

RUN mkdir -p data

EXPOSE 3000
CMD ["bun", "run", "apps/api/index.ts"]
