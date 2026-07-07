# Docker 镜像

本项目提供官方 Docker 镜像，支持多种部署方式。

## 镜像仓库

### GitHub Container Registry（推荐）

```bash
docker pull ghcr.io/your-username/omni:latest
```

### Docker Hub

```bash
docker pull your-username/omni:latest
```

## 可用标签

| 标签 | 描述 |
|------|------|
| `latest` | 最新稳定版本（跟踪 master 分支） |
| `v1.0.0` | 特定版本号 |
| `v1.0` | 主次版本号 |
| `v1` | 主版本号 |
| `master-abc1234` | 特定提交的构建 |
| `dev` | 开发版本 |

## 支持的架构

- `linux/amd64` (x86_64)
- `linux/arm64` (ARM64/AArch64)

## 快速开始

### 使用预构建镜像

```bash
# 使用 GitHub Container Registry
docker run -d \
  --name omni \
  -p 3000:3000 \
  -e DS_ACCOUNTS="email:password" \
  -e API_KEY="sk-your-key" \
  -v $(pwd)/logs:/app/logs \
  ghcr.io/your-username/omni:latest

# 使用 Docker Hub
docker run -d \
  --name omni \
  -p 3000:3000 \
  -e DS_ACCOUNTS="email:password" \
  -e API_KEY="sk-your-key" \
  -v $(pwd)/logs:/app/logs \
  your-username/omni:latest
```

### 使用 Docker Compose

修改 `docker-compose.yml` 中的 `image` 字段：

```yaml
services:
  omni:
    image: ghcr.io/your-username/omni:latest
    # 或
    # image: your-username/omni:latest
    # ... 其他配置
```

然后启动：

```bash
docker-compose up -d
```

## 构建自己的镜像

### 基础镜像

```bash
docker build -t omni:latest -f Dockerfile .
```

### 生产环境优化镜像

```bash
docker build -t omni:production -f Dockerfile.production .
```

### 构建多架构镜像

```bash
# 创建并使用 buildx builder
docker buildx create --name mybuilder --use

# 构建并推送多架构镜像
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t your-username/omni:latest \
  -f Dockerfile.production \
  --push \
  .
```

## 镜像详情

### 基础镜像

- 基于：`node:22-alpine`
- 大小：约 150-200 MB
- 用户：非 root 用户 (node)
- 工作目录：`/app`

### 包含组件

- Node.js 22 LTS
- npm 依赖（生产环境）
- dumb-init（生产镜像）
- 应用源码
- 健康检查脚本

### 暴露端口

- `3000` - HTTP API 端口

### 卷挂载点

- `/app/logs` - 日志目录

### 健康检查

- 间隔：30 秒
- 超时：10 秒
- 重试：3 次
- 启动时间：40 秒

## 环境变量

所有环境变量请参考 [.env.example](../.env.example)。

必需的环境变量：

- `DS_ACCOUNTS` 或 `DS_TOKENS` - DeepSeek 认证信息
- `API_KEY` - API 鉴权密钥（生产环境必需）

## 安全性

### 镜像扫描

所有推送到 GitHub Container Registry 的镜像都会通过 Trivy 进行安全漏洞扫描。

查看扫描结果：

1. 访问 GitHub 仓库的 Security 选项卡
2. 查看 Code scanning alerts

### 最佳实践

- ✅ 使用非 root 用户运行
- ✅ 最小化镜像体积（基于 Alpine）
- ✅ 多阶段构建
- ✅ 定期更新基础镜像
- ✅ 安全漏洞扫描
- ✅ 健康检查
- ✅ 信号处理（使用 dumb-init）

## 故障排查

### 拉取镜像失败

```bash
# GitHub Container Registry 需要登录
echo $GITHUB_TOKEN | docker login ghcr.io -u USERNAME --password-stdin
```

### 镜像无法启动

查看容器日志：

```bash
docker logs omni
```

检查健康状态：

```bash
docker inspect --format='{{.State.Health.Status}}' omni
```

### 权限问题

确保日志目录具有正确的权限：

```bash
mkdir -p logs
chmod 755 logs
```

## 自动构建

### GitHub Actions

本项目配置了 GitHub Actions 自动构建流程：

- 推送到 master/main 分支时自动构建
- 创建版本标签时自动构建并推送
- PR 时进行构建测试（不推送）
- 多架构构建（amd64 + arm64）
- 安全漏洞扫描

查看构建状态：

[![Docker Build](https://github.com/your-username/omni/actions/workflows/docker-build.yml/badge.svg)](https://github.com/your-username/omni/actions/workflows/docker-build.yml)

### 手动触发构建

1. 访问 GitHub Actions 页面
2. 选择 "Docker Build and Push" 工作流
3. 点击 "Run workflow"

## 版本管理

### 发布新版本

1. 创建并推送版本标签：

```bash
git tag v1.0.1
git push origin v1.0.1
```

2. GitHub Actions 会自动构建并推送以下标签的镜像：

- `v1.0.1`
- `v1.0`
- `v1`
- `latest`

## 许可证

与主项目相同。
