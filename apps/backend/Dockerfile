FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/frontend/package.json apps/frontend/package.json
RUN npm ci

COPY apps/backend apps/backend
RUN npm run prisma:generate -w @gamba/backend
RUN npm run build -w @gamba/backend
RUN npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/backend/node_modules apps/backend/node_modules
COPY --from=build /app/apps/backend/dist apps/backend/dist
COPY --from=build /app/apps/backend/package.json apps/backend/package.json
COPY --from=build /app/apps/backend/prisma apps/backend/prisma
WORKDIR /app/apps/backend
EXPOSE 3000
CMD ["sh", "-c", "node node_modules/prisma/build/index.js migrate deploy && node dist/main.js"]
