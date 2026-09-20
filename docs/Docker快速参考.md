# Docker 快速参考

## 🚀 快速启动

```bash
# 1. 复制配置
cp .env.docker .env

# 2. 编辑 .env，配置 DS_ACCOUNTS 或 DS_TOKENS

# 3. 启动服务
docker-compose up -d

# 4. 查看日志
docker-compose logs -f
```

## 📋 常用命令

### Docker Compose

| 命令 | 说明 |
|------|------|
| `docker-compose up -d` | 启动服务（后台运行） |
| `docker-compose down` | 停止并删除容器 |
| `docker-compose restart` | 重启服务 |
| `docker-compose logs -f` | 查看实时日志 |
| `docker-compose ps` | 查看服务状态 |
| `docker-compose exec omni sh` | 进入容器 shell |
| `docker-compose pull` | 拉取最新镜像 |
| `docker-compose up -d --build` | 重新构建并启动 |

### Makefile（推荐）

| 命令 | 说明 |
|------|------|
| `make help` | 查看所有命令 |
| `make deploy` | 一键部署（构建+启动+测试） |
| `make up` | 启动服务 |
| `make down` | 停止服务 |
| `make logs` | 查看实时日志 |
| `make status` | 查看服务状态 |
| `make shell` | 进入容器 |
| `make clean` | 清理容器和镜像 |

### 快速启动脚本

| 系统 | 命令 |
|------|------|
| Windows | `scripts\quick-start.bat` |
| Linux/macOS | `./scripts/quick-start.sh` |

## 🔍 故障排查

```bash
# 查看容器日志
docker logs omni

# 查看服务健康状态
docker inspect --format='{{.State.Health.Status}}' omni

# 查看资源使用
docker stats omni --no-stream

# 测试服务
curl http://localhost:3000/

# 进入容器调试
docker exec -it omni sh
```

## 🔧 配置修改

```bash
# 1. 修改 .env 文件
vim .env

# 2. 重启服务应用配置
docker-compose restart

# 或完全重建
docker-compose down
docker-compose up -d
```

## 📦 更新部署

```bash
# 拉取最新代码
git pull

# 重新构建并启动
docker-compose down
docker-compose up -d --build
```

## 🌐 访问地址

- 健康检查：http://localhost:3000/
- 管理面板：http://localhost:3000/admin
- 性能监控：http://localhost:3000/performance
- OpenAI API：http://localhost:3000/v1/chat/completions
- Claude API：http://localhost:3000/v1/messages

## 📝 环境变量

### 必需配置

```env
# DeepSeek 认证（至少配置一种）
DS_ACCOUNTS=email:password
DS_TOKENS=token1,token2
DS_TOKEN=single_token

# API 鉴权（生产环境必需）
API_KEY=sk-your-key
```

### 常用配置

```env
PORT=3000
MAX_CONCURRENT_PER_TOKEN=2
CLIENT_DEBUG_LOG=false
ENABLE_PROMPT_INJECTION=true
ENABLE_CONVERSATION_AFFINITY=false
```

## 📚 详细文档

- [Docker 部署总览](Docker部署总览.md)
- [Docker 部署指南](Docker部署指南.md)
- [Docker 镜像说明](Docker镜像说明.md)

## 💡 小贴士

1. **生产环境部署**
   ```bash
   docker-compose -f docker-compose.prod.yml up -d
   ```

2. **多副本部署**
   ```bash
   docker-compose up -d --scale omni=3
   ```

3. **查看最近 100 行日志**
   ```bash
   docker-compose logs --tail=100
   ```

4. **备份日志**
   ```bash
   tar -czf logs-backup-$(date +%Y%m%d).tar.gz logs/
   ```

5. **清理无用镜像**
   ```bash
   docker system prune -a
   ```
