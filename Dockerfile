FROM oven/bun:1 AS base
WORKDIR /app

# Install root deps
COPY package.json bun.lock* ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile --ignore-scripts

# Build client
COPY apps/web/ apps/web/
COPY tsconfig.json .
RUN cd apps/web && bun run build

# Copy server
COPY apps/api/ apps/api/

RUN mkdir -p data

EXPOSE 3000
CMD ["bun", "run", "apps/api/index.ts"]
