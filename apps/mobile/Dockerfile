FROM node:20-bookworm-slim
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/frontend/package.json apps/frontend/package.json
COPY apps/mobile/package.json apps/mobile/package.json
RUN npm ci

COPY apps/mobile apps/mobile
RUN npm run typecheck -w @gamba/mobile
WORKDIR /app/apps/mobile
RUN npx expo export --platform android --output-dir dist
