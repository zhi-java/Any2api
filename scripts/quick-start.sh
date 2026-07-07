#!/bin/bash
# 快速启动脚本

set -e

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}=== OmniAPI 快速启动 ===${NC}\n"

# 检查 .env 文件
if [ ! -f .env ]; then
    echo -e "${YELLOW}未找到 .env 文件，从模板创建...${NC}"
    if [ -f .env.docker ]; then
        cp .env.docker .env
        echo -e "${GREEN}✓ 已创建 .env 文件${NC}"
        echo -e "${YELLOW}⚠ 请编辑 .env 文件，配置必要的认证信息后重新运行${NC}"
        exit 1
    else
        echo -e "${RED}✗ 未找到 .env.docker 模板${NC}"
        exit 1
    fi
fi

# 检查 Docker
if ! command -v docker &> /dev/null; then
    echo -e "${RED}✗ 未安装 Docker${NC}"
    exit 1
fi

# 检查 Docker Compose
if docker compose version &> /dev/null; then
    COMPOSE_CMD="docker compose"
elif command -v docker-compose &> /dev/null; then
    COMPOSE_CMD="docker-compose"
else
    echo -e "${RED}✗ 未安装 Docker Compose${NC}"
    exit 1
fi

echo -e "${GREEN}检查环境...${NC}"

# 停止旧容器
if docker ps -a | grep -q omni; then
    echo -e "${YELLOW}停止旧容器...${NC}"
    $COMPOSE_CMD down
fi

# 构建并启动
echo -e "${GREEN}构建镜像...${NC}"
$COMPOSE_CMD build

echo -e "${GREEN}启动服务...${NC}"
$COMPOSE_CMD up -d

# 等待服务就绪
echo -e "${GREEN}等待服务启动...${NC}"
sleep 5

MAX_ATTEMPTS=30
ATTEMPT=0
while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
    if curl -sf http://localhost:3000/ > /dev/null 2>&1; then
        echo -e "\n${GREEN}✓ 服务已启动${NC}\n"

        echo -e "${GREEN}服务信息：${NC}"
        echo "  健康检查: http://localhost:3000/"
        echo "  管理面板: http://localhost:3000/admin"
        echo "  性能监控: http://localhost:3000/performance"
        echo ""
        echo -e "${GREEN}常用命令：${NC}"
        echo "  查看日志: docker-compose logs -f"
        echo "  停止服务: docker-compose down"
        echo "  重启服务: docker-compose restart"
        echo "  查看状态: docker-compose ps"
        echo ""
        echo -e "${GREEN}或使用 Makefile：${NC}"
        echo "  make logs    - 查看日志"
        echo "  make down    - 停止服务"
        echo "  make restart - 重启服务"
        echo "  make help    - 查看所有命令"

        exit 0
    fi

    ATTEMPT=$((ATTEMPT + 1))
    echo -n "."
    sleep 2
done

echo -e "\n${RED}✗ 服务启动超时${NC}"
echo -e "${YELLOW}查看日志：${NC}"
$COMPOSE_CMD logs --tail=50
exit 1
