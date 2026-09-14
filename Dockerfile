# ---------- 阶段 1：构建管理后台前端（Vite + React） ----------
FROM node:22-alpine AS web-builder

WORKDIR /web

COPY web/package*.json ./
RUN npm ci

COPY web/ ./
RUN npm run build


# ---------- 阶段 2：开发/精简运行时 ----------
FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY .env.example ./.env.example

# 前端构建产物
COPY --from=web-builder /web/dist ./src/admin/dist

RUN mkdir -p /app/logs && \
    chown -R node:node /app

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/healthz', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

CMD ["node", "src/index.js"]
