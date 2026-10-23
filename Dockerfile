# ── deps ────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY . .
RUN npm run build

# ── runner (standalone; no node_modules) ────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app

COPY --from=builder --chown=app:app /app/.next/standalone ./
COPY --from=builder --chown=app:app /app/.next/static ./.next/static

USER app
EXPOSE 3000
# The app writes FileAPL (.saleor-app.json) + the txn registry — mount a
# volume on /data and set PAYGLOCAL_TXN_STORE=/data/.payglocal-txn.json.
ENV HOME=/data
VOLUME ["/data"]

CMD ["node", "server.js"]
