# Docker 部署指南

本指南介绍如何使用 Docker 和 Docker Compose 部署 OmniAPI 服务。

## 前置要求

- Docker Engine 20.10+
- Docker Compose v2.0+ (或 docker-compose v1.29+)

## 快速开始

### 1. 准备环境配置

复制环境配置模板并根据实际需求修改：

```bash
cp .env.docker .env
```

编辑 `.env` 文件，至少配置以下必需项：

- **DeepSeek 认证**：配置 `DS_TOKEN`、`DS_TOKENS` 或 `DS_ACCOUNTS` 中的至少一项
- **API Key**：建议修改默认的 `API_KEY`，生产环境必须设置

### 2. 使用 Docker Compose 启动

```bash
# 构建并启动服务
docker-compose up -d

# 查看日志
docker-compose logs -f

# 查看服务状态
docker-compose ps
```

### 3. 验证服务

访问健康检查接口：

```bash
curl http://localhost:3000/
```

或访问管理面板：

```
http://localhost:3000/admin
```

### 4. 停止服务

```bash
# 停止服务
docker-compose stop

# 停止并删除容器
docker-compose down

# 停止并删除容器、网络和卷
docker-compose down -v
```

## 仅使用 Docker（不使用 Compose）

### 构建镜像

```bash
docker build -t omni:latest .
```

### 运行容器

```bash
docker run -d \
  --name omni \
  -p 3000:3000 \
  -e DS_ACCOUNTS="your_accounts_here" \
  -e API_KEY="sk-your-key" \
  -v $(pwd)/logs:/app/logs \
  --restart unless-stopped \
  omni:latest
```

### 查看日志

```bash
docker logs -f omni
```

### 停止和删除

```bash
docker stop omni
docker rm omni
```

## 配置说明

### 端口映射

默认情况下，服务监听 3000 端口。可以通过修改 `docker-compose.yml` 或在 `.env` 中设置 `PORT` 变量来更改宿主机端口：

```yaml
ports:
  - "8080:3000"  # 宿主机 8080 端口映射到容器 3000 端口
```

### 日志持久化

日志默认存储在容器内的 `/app/logs` 目录，通过 volume 映射到宿主机的 `./logs` 目录：

```yaml
volumes:
  - ./logs:/app/logs
```

日志文件包括：
- 请求日志：`logs/omni/YYYY-MM-DD.log`
- 调试日志（如启用）：`logs/omni/client-debug/YYYY-MM-DD.jsonl`

### 环境变量

所有环境变量都可以通过 `.env` 文件或 `docker-compose.yml` 的 `environment` 部分配置。主要配置项：

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `DS_ACCOUNTS` | DeepSeek 账号列表 | - |
| `API_KEY` | API 鉴权密钥 | `sk-zhi` |
| `PORT` | 服务端口 | `3000` |
| `LOG_DIR` | 日志目录 | `/app/logs` |
| `ENABLE_PROMPT_INJECTION` | 启用提示词注入 | `true` |
| `ENABLE_CONVERSATION_AFFINITY` | 启用对话亲和 | `false` |

完整配置说明请参考 `.env.example` 文件。

## 生产环境建议

### 1. 安全配置

- **必须设置 API_KEY**：防止未授权访问
- **使用环境变量**：避免在镜像中硬编码敏感信息
- **限制容器权限**：已使用非 root 用户运行

### 2. 反向代理

建议使用 Nginx 或 Traefik 作为反向代理，配置 HTTPS：

```nginx
server {
    listen 443 ssl http2;
    server_name api.example.com;
    
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### 3. 资源限制

在 `docker-compose.yml` 中添加资源限制：

```yaml
services:
  omni:
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G
        reservations:
          cpus: '0.5'
          memory: 512M
```

### 4. 日志轮转

配置日志轮转以避免磁盘占满：

```yaml
services:
  omni:
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

### 5. 健康检查

服务已内置健康检查，Docker 会自动监控服务状态并在失败时重启容器。可以通过以下命令查看健康状态：

```bash
docker inspect --format='{{.State.Health.Status}}' omni
```

## 故障排查

### 容器无法启动

1. 检查日志：
```bash
docker-compose logs omni
```

2. 验证环境变量：
```bash
docker-compose config
```

3. 确认端口未被占用：
```bash
netstat -tuln | grep 3000
```

### 健康检查失败

1. 进入容器检查：
```bash
docker exec -it omni sh
curl http://localhost:3000/
```

2. 检查应用日志：
```bash
docker exec omni cat /app/logs/omni/$(date +%Y-%m-%d).log
```

### 性能问题

1. 查看容器资源使用：
```bash
docker stats omni
```

2. 调整 Token 池和队列参数：
```env
MAX_CONCURRENT_PER_TOKEN=4
TOKEN_DEAD_THRESHOLD=10
```

## 更新部署

### 拉取新代码并重新构建

```bash
git pull
docker-compose down
docker-compose up -d --build
```

### 零停机更新

```bash
# 构建新镜像
docker-compose build

# 滚动更新（需要多副本）
docker-compose up -d --no-deps --scale omni=2 omni
docker-compose up -d --no-deps --scale omni=1 omni
```

## 备份与恢复

### 备份数据

```bash
# 备份日志
tar -czf logs-backup-$(date +%Y%m%d).tar.gz logs/

# 备份配置
cp .env .env.backup
```

### 恢复数据

```bash
# 恢复日志
tar -xzf logs-backup-20260707.tar.gz

# 恢复配置
cp .env.backup .env
```

## 监控与告警

建议集成以下监控工具：

- **Prometheus + Grafana**：监控容器资源和应用指标
- **Loki**：日志聚合和查询
- **Alertmanager**：告警通知

服务提供以下监控端点：

- 健康检查：`GET /`
- 性能指标：`GET /performance`（需要 API Key）
- 管理面板：`GET /admin`

## 常见问题

**Q: 如何更改服务端口？**

A: 修改 `docker-compose.yml` 中的端口映射，例如改为 8080：
```yaml
ports:
  - "8080:3000"
```

**Q: 日志文件过大如何处理？**

A: 启用 Docker 日志轮转或配置应用的 `CLIENT_DEBUG_LOG=false` 关闭调试日志。

**Q: 如何连接外部代理？**

A: 在 `.env` 中配置 `HTTPS_PROXY` 和 `HTTP_PROXY` 变量。

**Q: 容器内如何访问宿主机服务？**

A: 使用 `host.docker.internal` 作为宿主机地址（需要 Docker 18.03+）。

## 支持

如有问题或建议，请访问项目仓库提交 Issue。
