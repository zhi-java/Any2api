#!/bin/bash
# Docker 部署脚本

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 配置
IMAGE_NAME="omni"
CONTAINER_NAME="omni"
ENV_FILE=".env"

# 打印带颜色的消息
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 检查环境配置
check_env() {
    if [ ! -f "$ENV_FILE" ]; then
        log_error "未找到 $ENV_FILE 文件"
        log_info "请复制 .env.docker 为 .env 并配置必要的环境变量"
        exit 1
    fi

    # 检查必需的环境变量
    source "$ENV_FILE"
    if [ -z "$DS_ACCOUNTS" ] && [ -z "$DS_TOKENS" ] && [ -z "$DS_TOKEN" ]; then
        log_error "未配置 DeepSeek 认证信息"
        log_info "请在 $ENV_FILE 中配置 DS_ACCOUNTS、DS_TOKENS 或 DS_TOKEN"
        exit 1
    fi

    log_info "环境配置检查通过"
}

# 构建镜像
build_image() {
    log_info "开始构建 Docker 镜像..."
    docker build -t "${IMAGE_NAME}:latest" .
    log_info "镜像构建完成"
}

# 停止旧容器
stop_old_container() {
    if docker ps -a | grep -q "$CONTAINER_NAME"; then
        log_info "停止旧容器..."
        docker stop "$CONTAINER_NAME" || true
        docker rm "$CONTAINER_NAME" || true
    fi
}

# 启动容器
start_container() {
    log_info "启动新容器..."
    docker run -d \
        --name "$CONTAINER_NAME" \
        -p "${PORT:-3000}:3000" \
        --env-file "$ENV_FILE" \
        -v "$(pwd)/logs:/app/logs" \
        --restart unless-stopped \
        "${IMAGE_NAME}:latest"

    log_info "容器已启动"
}

# 等待服务就绪
wait_for_service() {
    log_info "等待服务就绪..."
    local max_attempts=30
    local attempt=0

    while [ $attempt -lt $max_attempts ]; do
        if curl -sf "http://localhost:${PORT:-3000}/" > /dev/null 2>&1; then
            log_info "服务已就绪"
            return 0
        fi

        attempt=$((attempt + 1))
        echo -n "."
        sleep 2
    done

    echo ""
    log_error "服务启动超时"
    docker logs "$CONTAINER_NAME"
    return 1
}

# 显示状态
show_status() {
    log_info "服务状态："
    docker ps | grep "$CONTAINER_NAME"

    log_info "服务地址："
    echo "  健康检查: http://localhost:${PORT:-3000}/"
    echo "  管理面板: http://localhost:${PORT:-3000}/admin"
    echo "  性能监控: http://localhost:${PORT:-3000}/performance"
}

# 主函数
main() {
    log_info "开始 Docker 部署流程"

    # 检查 Docker 是否安装
    if ! command -v docker &> /dev/null; then
        log_error "未检测到 Docker，请先安装 Docker"
        exit 1
    fi

    check_env
    build_image
    stop_old_container
    start_container

    if wait_for_service; then
        show_status
        log_info "部署完成！"
    else
        log_error "部署失败"
        exit 1
    fi
}

# 执行主函数
main
