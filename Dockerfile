FROM oven/bun:1 AS build
WORKDIR /app

# Install root deps
COPY package.json bun.lock* ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/site/package.json apps/site/
RUN bun install --frozen-lockfile --ignore-scripts

# Build client
COPY apps/web/ apps/web/
COPY tsconfig.json .
RUN cd apps/web && bun run build

# Production stage
FROM oven/bun:1-slim
WORKDIR /app

COPY package.json bun.lock* ./
COPY apps/api/package.json apps/api/
COPY apps/site/package.json apps/site/
RUN bun install --frozen-lockfile --ignore-scripts --production

# Copy built client and server source
COPY --from=build /app/apps/web/dist apps/web/dist
COPY apps/api/ apps/api/

RUN mkdir -p data && chown -R bun:bun data
USER bun

EXPOSE 3000
CMD ["bun", "run", "apps/api/index.ts"]
