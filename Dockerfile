# 使用官方 Node.js 22 LTS 镜像作为基础镜像
FROM node:22-alpine

# 设置工作目录
WORKDIR /app

# 设置环境变量
ENV NODE_ENV=production \
    PORT=3000

# 复制 package.json 和 package-lock.json（如果存在）
COPY package*.json ./

# 安装生产依赖
RUN npm ci --only=production && \
    npm cache clean --force

# 复制应用源码
COPY src ./src
COPY .env.example ./.env.example

# 创建日志目录
RUN mkdir -p /app/logs && \
    chown -R node:node /app

# 使用非 root 用户运行应用
USER node

# 暴露端口
EXPOSE 3000

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# 启动应用
CMD ["node", "src/index.js"]
