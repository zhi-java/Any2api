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

# 前端构建产物。
# vite.config.ts 的 outDir 是 '../src/admin/dist'（相对 web/），
# 容器内即 /web/../src/admin/dist → /src/admin/dist。
COPY --from=web-builder /src/admin/dist ./src/admin/dist

# /app/logs 与 /data 均为挂载点。预创建目录本身无法改变命名卷的属主，
# 因此同时设置挂载点属主（命名卷首次挂载会继承镜像内该路径的权限）。
RUN mkdir -p /app/logs /data && \
    chown -R node:node /app /data

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/healthz', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

CMD ["node", "src/index.js"]
