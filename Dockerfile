FROM node:22-slim AS base
WORKDIR /app

# ── Backend: install prod deps + compile (postinstall runs tsc) ──
FROM base AS backend
COPY package.json package-lock.json* tsconfig.json ./
COPY src/ ./src/
RUN npm ci --omit=dev
COPY config/ ./config/

# ── Dashboard build ────────────────────────────────────────────
FROM node:22-slim AS dashboard-build
WORKDIR /app/dashboard
COPY dashboard/package.json dashboard/package-lock.json* ./
RUN npm install
COPY dashboard/ ./
RUN npm run build

# ── Final image ────────────────────────────────────────────────
FROM node:22-slim AS runner
WORKDIR /app

COPY --from=backend /app/package.json ./package.json
COPY --from=backend /app/node_modules ./node_modules
COPY --from=backend /app/dist ./dist
COPY --from=backend /app/config ./config
COPY --from=dashboard-build /app/dist/public ./dist/public

RUN mkdir -p data logs

ENV NODE_ENV=production
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "require('http').get('http://localhost:3001/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/index.js"]
