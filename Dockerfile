FROM node:20-alpine AS base
WORKDIR /app

# ── Backend build ──────────────────────────────────────────────
FROM base AS backend-deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM base AS backend-build
COPY package.json package-lock.json* tsconfig.json ./
RUN npm ci
COPY src/ ./src/
COPY config/ ./config/
RUN npm run build

# ── Dashboard build ────────────────────────────────────────────
FROM node:20-alpine AS dashboard-build
WORKDIR /app/dashboard
COPY dashboard/package.json dashboard/package-lock.json* ./
RUN npm ci
COPY dashboard/ ./
RUN npm run build

# ── Final image ────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

# Install only production deps
COPY --from=backend-deps /app/node_modules ./node_modules
COPY --from=backend-build /app/dist ./dist
COPY --from=backend-build /app/config ./config
COPY --from=dashboard-build /app/dist/public ./dist/public

# Serve static dashboard from Express
RUN mkdir -p data logs

ENV NODE_ENV=production
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3001/health || exit 1

CMD ["node", "dist/index.js"]
