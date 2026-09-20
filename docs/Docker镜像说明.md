# Docker 镜像

本项目提供官方 Docker 镜像，推送至 GitHub Container Registry（GHCR）。

## 镜像地址

```bash
docker pull ghcr.io/zhi-java/any2api:latest
```

仅发布到 GHCR，不发布 Docker Hub。

## 可用标签

| 标签 | 说明 |
|------|------|
| `latest` | 默认分支（master）最新构建 |
| `1.1.0` / `1.1` / `1` | 版本号（创建 `v*` 标签时生成） |
| `sha-<短提交>` | 特定提交的构建 |
| `master` | master 分支最新构建 |

版本标签由 CI 中的 `docker/metadata-action` 依据 git tag 自动生成，
`latest` 仅在默认分支构建时更新。

## 支持的架构

- `linux/amd64` (x86_64)
- `linux/arm64` (ARM64/AArch64)

两个架构由 CI 通过 buildx 构建为单一多架构 manifest，
拉取时 Docker 会按宿主平台自动选择。

## 快速开始

### 使用预构建镜像

```bash
docker run -d \
  --name omni \
  -p 3000:3000 \
  -e DS_ACCOUNTS="email:password" \
  -e API_KEY="sk-your-key" \
  -v omni-data:/data \
  -v "$(pwd)/logs:/app/logs" \
  ghcr.io/zhi-java/any2api:latest
```

> `-v omni-data:/data` 用于持久化配置。后台添加的凭据与运行配置写在
> `/data/config.json`，不挂载则容器重建后丢失。

### 使用 Docker Compose（推荐）

仓库中的 `docker-compose.yml` 已默认指向发布镜像：

```bash
cp .env.docker .env   # 然后编辑 .env 填入 DS_ACCOUNTS 或 DS_TOKENS
docker compose up -d
```

如需从本地源码构建（例如修改了代码）：

```bash
docker compose up -d --build
```

## 构建自己的镜像

CI 与本地使用**同一个 `Dockerfile`**，构建结果一致，不存在"本地跑得好、
发布镜像不同"的差异。

```bash
docker build -t any2api:local .
```

构建多架构镜像：

```bash
docker buildx create --name mybuilder --use

docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t your-registry/any2api:latest \
  --push \
  .
```

## 镜像详情

### 基础镜像

- 基于：`node:22-alpine`
- 用户：非 root 用户 `node`（uid 1000）
- 工作目录：`/app`

### 构建阶段

采用三阶段构建，最终镜像不含构建工具：

1. **web-builder** — 用 Vite 构建管理后台前端
2. **deps** — 安装后端生产依赖（`npm ci --omit=dev`）
3. **production** — 仅保留 Node 运行时、生产依赖与前端产物

### 关于 npm

生产镜像中**已移除 npm / npx / corepack**。运行阶段只需 `node`
可执行文件，而 npm 自带的依赖树（`pacote`、`sigstore`、`tar`、
`brace-expansion`、`picomatch`、`ip-address` 等）是镜像中绝大多数
高危漏洞的来源，且在本服务中永远不会被执行。

同时镜像构建时执行 `apk upgrade`，确保 Alpine 基础包（如 openssl）
为已修复版本。

### 暴露端口

- `3000` — HTTP API 端口

### 卷挂载点

- `/data` — 配置目录（`config.json`，后台添加的凭据与运行配置）
- `/app/logs` — 日志目录

### 健康检查

- 端点：`/healthz`
- 间隔：30 秒 / 超时：10 秒 / 重试：3 次 / 启动宽限：40 秒

## 环境变量

所有环境变量请参考 [.env.example](../.env.example)。最常用的几项：

| 变量 | 说明 |
|------|------|
| `DS_ACCOUNTS` | DeepSeek 账号，`邮箱:密码`，逗号分隔 |
| `DS_TOKENS` | DeepSeek Token，逗号分隔（与账号二选一） |
| `API_KEY` | API 鉴权密钥，同时用于管理后台登录 |
| `PORT` | 宿主机映射端口 |

其余参数均有内置默认值，可在管理后台「设置」页面调整并持久化到 `/data`。

## 安全性

### 镜像扫描

推送至 GHCR 的镜像会经 Trivy 扫描，结果以 SARIF 格式上报到仓库的
Security → Code scanning。

### 最佳实践

- ✅ 非 root 用户运行
- ✅ 基于 Alpine，多阶段构建
- ✅ 移除 npm 工具链，缩小攻击面
- ✅ 构建时升级 Alpine 基础包
- ✅ 安全漏洞扫描
- ✅ 健康检查
- ✅ 使用 dumb-init 正确处理信号

## 故障排查

### 拉取镜像失败（unauthorized）

镜像为公开包时可直接拉取。若返回 `unauthorized`，说明该包当前为私有，
需要先登录：

```bash
echo "$GITHUB_TOKEN" | docker login ghcr.io -u <你的用户名> --password-stdin
```

`GITHUB_TOKEN` 需具备 `read:packages` 权限。

### 镜像无法启动

```bash
docker logs omni
docker inspect --format='{{.State.Health.Status}}' omni
```

### 权限问题

确保日志目录存在且可写：

```bash
mkdir -p logs
```

## 自动构建

### GitHub Actions

`.github/workflows/docker-build.yml` 配置：

- 推送到 master / main 分支时构建并推送
- 创建 `v*` 标签时构建并推送版本号标签
- PR 时构建验证（不推送）
- 多架构构建（amd64 + arm64）
- 安全漏洞扫描

### 发布新版本

```bash
git tag -a v1.1.0 -m "v1.1.0"
git push origin v1.1.0
```

CI 会自动构建并推送 `1.1.0`、`1.1`、`1`、`sha-<提交>`、`latest`。

## 许可证

与主项目相同。
