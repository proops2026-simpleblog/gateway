# ---- Builder stage: installs deps (incl. dev) for a reproducible build ----
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# ---- Runtime stage: slim, non-root, production-only ----
FROM node:20-alpine AS runtime

ENV NODE_ENV=production

WORKDIR /app

# Non-root user to run the service.
RUN addgroup -S gateway && adduser -S gateway -G gateway

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY package.json ./

USER gateway

EXPOSE 3000

# No database/migrations owned by this service — start the server directly.
CMD ["node", "src/index.js"]
