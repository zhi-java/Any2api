# 多阶段构建。这是唯一的 Dockerfile：CI 发布镜像与本地 docker compose
# 构建使用同一份定义，避免"本地跑得好、发布镜像不同"的偏差。
#
# 镜像形态：Node 运行时 + 已构建的管理后台静态资源 + 生产依赖，
# 不含 npm 工具链（见阶段 3 的说明）。

# ---------- 阶段 1：构建管理后台前端（Vite + React） ----------
FROM node:22-alpine AS web-builder

WORKDIR /web

# 先装依赖，利用层缓存
COPY web/package*.json ./
RUN npm ci

# 再复制源码并构建（输出到 src/admin/dist）
COPY web/ ./
RUN npm run build


# ---------- 阶段 2：安装后端生产依赖 ----------
FROM node:22-alpine AS deps

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force


# ---------- 阶段 3：生产运行时 ----------
FROM node:22-alpine AS production

WORKDIR /app

# 1) dumb-init 正确转发信号，让容器能优雅处理 SIGTERM。
# 2) 升级 Alpine 基础包，修复基础镜像自带的 openssl 等漏洞
#    （构建时快照可能落后于最新补丁版本）。
RUN apk upgrade --no-cache && \
    apk add --no-cache dumb-init

# 移除 npm / npx / corepack。运行阶段只需 node 可执行文件，而 npm 自带的
# 依赖树（pacote、sigstore、tar、brace-expansion、picomatch、ip-address 等，
# 位于 /usr/local/lib/node_modules/npm/node_modules/）是镜像中绝大多数
# 高危/严重漏洞的来源，且这些代码在本服务中永远不会被执行。
# 配套的 docker-entrypoint.sh 不引用 npm，移除不影响启动。
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack && \
    rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

ENV NODE_ENV=production \
    PORT=3000

COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
COPY .env.example ./.env.example

# 前端构建产物（Vite base 指向 /admin/，Express 从 src/admin/dist 托管）。
# vite.config.ts 的 outDir 是 '../src/admin/dist'（相对 web/），
# 容器内即 /web/../src/admin/dist → /src/admin/dist。
COPY --from=web-builder /src/admin/dist ./src/admin/dist

# 日志与数据目录权限。
# /app/logs 与 /data 均为挂载点，预创建并设置属主，使命名卷首次挂载时
# 节点用户（uid 1000）可写，避免运行时 EACCES。
RUN mkdir -p /app/logs /data && \
    chown -R node:node /app /data && \
    chmod -R 755 /app /data

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/healthz', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]
