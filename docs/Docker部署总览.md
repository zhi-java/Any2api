# OmniAPI Docker 部署完整指南

## 📋 目录

- [概述](#概述)
- [文件清单](#文件清单)
- [快速开始](#快速开始)
- [部署方式](#部署方式)
- [配置说明](#配置说明)
- [运维管理](#运维管理)
- [故障排查](#故障排查)

## 概述

本项目已完整集成 Docker 部署功能，支持：

- ✅ 单容器部署
- ✅ Docker Compose 编排
- ✅ 多架构支持（amd64/arm64）
- ✅ 多阶段构建优化
- ✅ 自动健康检查
- ✅ 日志持久化
- ✅ 环境变量配置
- ✅ CI/CD 自动构建
- ✅ 一键部署脚本

## 文件清单

### Docker 配置文件

```
├── Dockerfile                    # 唯一的 Dockerfile（CI 与本地共用）
├── docker-compose.yml            # 默认 Compose 配置（拉取发布镜像）
├── docker-compose.prod.yml       # 生产环境 Compose 配置
├── .dockerignore                 # Docker 构建忽略文件
└── .env.docker                   # Docker 环境变量模板
```

### 部署脚本

```
├── scripts/
│   ├── docker-deploy.sh          # Linux/macOS 部署脚本
│   ├── docker-deploy.bat         # Windows 部署脚本
│   ├── quick-start.sh            # Linux/macOS 快速启动
│   └── quick-start.bat           # Windows 快速启动
├── Makefile                      # Make 命令集
```

### 文档

```
├── docs/
│   ├── Docker部署指南.md         # 详细部署指南
│   └── Docker镜像说明.md         # 镜像使用说明
```

### CI/CD

```
└── .github/
    └── workflows/
        └── docker-build.yml      # GitHub Actions 自动构建
```

## 快速开始

### 方式一：使用快速启动脚本（推荐新手）

**Windows：**

```cmd
# 双击运行或命令行执行
scripts\quick-start.bat
```

**Linux/macOS：**

```bash
chmod +x scripts/quick-start.sh
./scripts/quick-start.sh
```

脚本会自动：
1. 检查 Docker 环境
2. 创建 .env 配置文件
3. 构建 Docker 镜像
4. 启动服务
5. 等待服务就绪
6. 显示访问地址

### 方式二：使用 Docker Compose

```bash
# 1. 复制环境配置
cp .env.docker .env

# 2. 编辑 .env 文件，配置认证信息
# 至少配置 DS_ACCOUNTS 或 DS_TOKENS

# 3. 启动服务
docker-compose up -d

# 4. 查看日志
docker-compose logs -f

# 5. 验证服务
curl http://localhost:3000/
```

### 方式三：使用 Makefile（推荐开发者）

```bash
# 查看所有可用命令
make help

# 一键部署（构建+启动+测试）
make deploy

# 生产环境部署
make deploy-prod

# 查看日志
make logs

# 停止服务
make down
```

### 方式四：直接使用 Docker

```bash
# 构建镜像
docker build -t omni:latest .

# 运行容器
docker run -d \
  --name omni \
  -p 3000:3000 \
  -e DS_ACCOUNTS="email:password" \
  -e API_KEY="sk-your-key" \
  -v $(pwd)/logs:/app/logs \
  --restart unless-stopped \
  omni:latest
```

## 部署方式

### 1. 开发/测试环境

使用 `docker-compose.yml`：

```bash
docker-compose up -d
```

特点：
- 日志挂载到本地 `./logs` 目录
- 支持热重载（如需要可配置）
- 无资源限制
- 适合开发调试

### 2. 生产环境

使用 `docker-compose.prod.yml`：

```bash
docker-compose -f docker-compose.prod.yml up -d
```

特点：
- 多阶段构建，镜像体积更小
- 使用 dumb-init 正确处理信号
- 配置资源限制（CPU/内存）
- 日志轮转（最多 5 个文件，每个 10MB）
- 使用 Docker volume 持久化
- 适合生产部署

### 3. 高可用部署

使用多副本 + 负载均衡：

```bash
# 启动 3 个副本
docker-compose up -d --scale omni=3

# 配合 Nginx 负载均衡
# 参考 docs/Docker部署指南.md 中的 Nginx 配置
```

## 配置说明

### 必需配置

在 `.env` 文件中至少配置以下项：

```env
# DeepSeek 认证（至少配置一种）
DS_ACCOUNTS=email1:password1,email2:password2
# 或
DS_TOKENS=token1,token2
# 或
DS_TOKEN=single_token

# API 鉴权（生产环境必需）
API_KEY=sk-your-secret-key
```

### 可选配置

```env
# 服务端口（容器内固定 3000，宿主机端口在 docker-compose.yml 修改）
PORT=3000

# 代理设置
HTTPS_PROXY=http://proxy.example.com:8080
HTTP_PROXY=http://proxy.example.com:8080

# Token 池调优
MAX_CONCURRENT_PER_TOKEN=2
TOKEN_DEAD_THRESHOLD=5

# 日志配置
CLIENT_DEBUG_LOG=false
LOG_DIR=/app/logs

# 功能开关
ENABLE_PROMPT_INJECTION=true
ENABLE_CONVERSATION_AFFINITY=false
```

完整配置说明请参考 `.env.example` 文件。

### 端口映射

修改 `docker-compose.yml` 中的端口映射：

```yaml
ports:
  - "8080:3000"  # 宿主机 8080 端口 → 容器 3000 端口
```

## 运维管理

### 常用命令

#### 使用 Docker Compose

```bash
# 启动服务
docker-compose up -d

# 停止服务
docker-compose down

# 重启服务
docker-compose restart

# 查看日志
docker-compose logs -f

# 查看最近 100 行日志
docker-compose logs --tail=100

# 查看服务状态
docker-compose ps

# 进入容器
docker-compose exec omni sh

# 更新服务
docker-compose pull
docker-compose up -d
```

#### 使用 Makefile

```bash
make help        # 查看所有命令
make build       # 构建镜像
make up          # 启动服务
make down        # 停止服务
make logs        # 查看日志
make status      # 查看状态
make shell       # 进入容器
make test        # 测试服务
make deploy      # 一键部署
make clean       # 清理容器和镜像
```

#### 使用 Docker 命令

```bash
# 查看容器日志
docker logs -f omni

# 查看容器状态
docker ps | grep omni

# 查看健康状态
docker inspect --format='{{.State.Health.Status}}' omni

# 查看资源使用
docker stats omni --no-stream

# 进入容器
docker exec -it omni sh

# 停止容器
docker stop omni

# 启动容器
docker start omni

# 重启容器
docker restart omni

# 删除容器
docker rm -f omni
```

### 日志管理

#### 查看应用日志

```bash
# 容器内日志
docker-compose exec omni ls -lh /app/logs/omni/

# 宿主机日志（通过 volume 映射）
ls -lh logs/omni/

# 实时查看日志
tail -f logs/omni/$(date +%Y-%m-%d).log
```

#### 日志轮转

生产环境配置了 Docker 日志轮转：

```yaml
logging:
  driver: "json-file"
  options:
    max-size: "10m"   # 单个文件最大 10MB
    max-file: "5"     # 最多保留 5 个文件
```

### 备份与恢复

#### 备份

```bash
# 备份日志
tar -czf logs-backup-$(date +%Y%m%d).tar.gz logs/

# 备份配置
cp .env .env.backup

# 备份 Docker volume
docker run --rm \
  -v zhi2api_logs:/data \
  -v $(pwd):/backup \
  alpine tar czf /backup/volume-backup.tar.gz -C /data .
```

#### 恢复

```bash
# 恢复日志
tar -xzf logs-backup-20260707.tar.gz

# 恢复配置
cp .env.backup .env

# 恢复 Docker volume
docker run --rm \
  -v zhi2api_logs:/data \
  -v $(pwd):/backup \
  alpine sh -c "cd /data && tar xzf /backup/volume-backup.tar.gz"
```

### 更新部署

#### 标准更新

```bash
# 拉取最新代码
git pull

# 停止服务
docker-compose down

# 重新构建并启动
docker-compose up -d --build
```

#### 零停机更新（需要多副本）

```bash
# 方式一：使用 Makefile
make update

# 方式二：手动执行
docker-compose build
docker-compose up -d --no-deps --scale omni=2 omni
sleep 5
docker-compose up -d --no-deps --scale omni=1 omni
```

## 故障排查

### 容器无法启动

**问题：** 执行 `docker-compose up -d` 后容器立即退出

**排查步骤：**

```bash
# 1. 查看容器日志
docker-compose logs omni

# 2. 检查配置
docker-compose config

# 3. 确认端口未被占用
netstat -tuln | grep 3000

# 4. 检查环境变量
docker-compose exec omni env | grep -E 'DS_|API_KEY'

# 5. 手动启动查看详细错误
docker-compose up
```

**常见原因：**
- 未配置 DeepSeek 认证信息
- 端口 3000 已被占用
- .env 文件格式错误
- 缺少必要的依赖

### 健康检查失败

**问题：** 容器状态显示 `unhealthy`

**排查步骤：**

```bash
# 1. 查看健康检查日志
docker inspect --format='{{range .State.Health.Log}}{{.Output}}{{end}}' omni

# 2. 手动测试健康检查
docker exec omni curl -f http://localhost:3000/

# 3. 检查应用日志
docker logs omni --tail=50

# 4. 进入容器调试
docker exec -it omni sh
curl http://localhost:3000/
```

**常见原因：**
- 应用启动时间过长（超过 40 秒）
- 认证信息配置错误导致服务无法初始化
- 网络问题

### 无法访问服务

**问题：** 从宿主机无法访问 `http://localhost:3000/`

**排查步骤：**

```bash
# 1. 确认容器正在运行
docker ps | grep omni

# 2. 检查端口映射
docker port omni

# 3. 测试容器内服务
docker exec omni curl -f http://localhost:3000/

# 4. 检查防火墙规则
# Windows
netsh advfirewall firewall show rule name=all | findstr 3000
# Linux
sudo iptables -L | grep 3000

# 5. 确认宿主机端口绑定
netstat -tuln | grep 3000
```

**常见原因：**
- 防火墙阻止端口
- 端口映射配置错误
- 容器网络模式不正确

### 权限问题

**问题：** 无法写入日志或访问文件

**排查步骤：**

```bash
# 1. 检查容器内文件权限
docker exec omni ls -la /app/logs

# 2. 检查宿主机目录权限
ls -la logs/

# 3. 修复权限
chmod -R 755 logs/
chown -R $USER:$USER logs/

# 4. 确认容器使用的用户
docker exec omni whoami
docker exec omni id
```

### 性能问题

**问题：** 服务响应缓慢

**排查步骤：**

```bash
# 1. 查看资源使用情况
docker stats omni

# 2. 检查容器资源限制
docker inspect omni | grep -A 10 Resources

# 3. 调整资源限制（在 docker-compose.prod.yml 中）
deploy:
  resources:
    limits:
      cpus: '4'      # 增加 CPU 限制
      memory: 4G     # 增加内存限制

# 4. 调优应用配置
# 在 .env 中增加并发数
MAX_CONCURRENT_PER_TOKEN=4
```

### 日志不输出

**问题：** 看不到应用日志

**排查步骤：**

```bash
# 1. 确认日志目录挂载
docker inspect omni | grep -A 5 Mounts

# 2. 检查日志配置
docker exec omni env | grep LOG

# 3. 手动检查日志文件
docker exec omni ls -la /app/logs/omni/

# 4. 查看 Docker 容器日志
docker logs omni
```

## 生产环境建议

### 安全加固

1. **必须设置强 API Key**
   ```env
   API_KEY=sk-$(openssl rand -hex 32)
   ```

2. **使用 HTTPS**
   - 通过 Nginx 反向代理配置 SSL
   - 参考 `docs/Docker部署指南.md` 中的 Nginx 配置

3. **限制容器权限**
   ```yaml
   security_opt:
     - no-new-privileges:true
   cap_drop:
     - ALL
   ```

4. **使用 Docker secrets 管理敏感信息**
   ```yaml
   secrets:
     - api_key
   ```

### 监控告警

1. **集成 Prometheus**
   - 暴露 metrics 端点
   - 配置 Prometheus 抓取

2. **日志聚合**
   - 使用 ELK Stack 或 Loki
   - 配置日志转发

3. **健康监控**
   - 配置 Uptime 监控
   - 设置告警规则

### 高可用部署

1. **负载均衡**
   ```bash
   # 多副本部署
   docker-compose up -d --scale omni=3
   ```

2. **自动重启**
   ```yaml
   restart: always
   ```

3. **资源预留**
   ```yaml
   deploy:
     resources:
       reservations:
         cpus: '0.5'
         memory: 512M
   ```

## 相关文档

- [详细部署指南](Docker部署指南.md)
- [镜像使用说明](Docker镜像说明.md)
- [项目 README](../README.md)

## 技术支持

如有问题或建议：

1. 查看 [常见问题](#故障排查)
2. 搜索或提交 GitHub Issue
3. 查看项目文档

---

**最后更新：** 2026-07-07
