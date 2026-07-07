.PHONY: help build up down logs restart clean test deploy

# 默认目标
help:
	@echo "OmniAPI Docker 管理命令"
	@echo ""
	@echo "使用方法: make [target]"
	@echo ""
	@echo "可用命令："
	@echo "  build       - 构建 Docker 镜像"
	@echo "  up          - 启动服务（开发环境）"
	@echo "  up-prod     - 启动服务（生产环境）"
	@echo "  down        - 停止服务"
	@echo "  restart     - 重启服务"
	@echo "  logs        - 查看实时日志"
	@echo "  logs-tail   - 查看最近 100 行日志"
	@echo "  status      - 查看服务状态"
	@echo "  shell       - 进入容器 shell"
	@echo "  clean       - 清理容器和镜像"
	@echo "  clean-all   - 清理所有内容（包括日志和卷）"
	@echo "  test        - 测试服务健康状态"
	@echo "  deploy      - 一键部署（构建+启动+测试）"
	@echo ""

# 构建镜像
build:
	@echo "构建 Docker 镜像..."
	docker-compose build

# 构建生产镜像
build-prod:
	@echo "构建生产环境 Docker 镜像..."
	docker-compose -f docker-compose.prod.yml build

# 启动服务（开发环境）
up:
	@echo "启动开发环境服务..."
	docker-compose up -d
	@echo "服务已启动，访问 http://localhost:3000"

# 启动服务（生产环境）
up-prod:
	@echo "启动生产环境服务..."
	docker-compose -f docker-compose.prod.yml up -d
	@echo "服务已启动，访问 http://localhost:3000"

# 停止服务
down:
	@echo "停止服务..."
	docker-compose down

# 停止生产服务
down-prod:
	@echo "停止生产环境服务..."
	docker-compose -f docker-compose.prod.yml down

# 重启服务
restart: down up

# 重启生产服务
restart-prod: down-prod up-prod

# 查看实时日志
logs:
	docker-compose logs -f

# 查看最近 100 行日志
logs-tail:
	docker-compose logs --tail=100

# 查看生产环境日志
logs-prod:
	docker-compose -f docker-compose.prod.yml logs -f

# 查看服务状态
status:
	@echo "容器状态："
	@docker-compose ps
	@echo ""
	@echo "健康检查："
	@curl -sf http://localhost:3000/ && echo "✓ 服务正常" || echo "✗ 服务异常"

# 进入容器 shell
shell:
	docker-compose exec omni sh

# 清理容器和镜像
clean:
	@echo "清理容器和镜像..."
	docker-compose down --rmi local
	@echo "清理完成"

# 清理所有内容（包括日志和卷）
clean-all:
	@echo "警告：此操作将删除所有容器、镜像、卷和日志！"
	@read -p "确认继续？[y/N] " -n 1 -r; \
	echo; \
	if [[ $$REPLY =~ ^[Yy]$$ ]]; then \
		docker-compose down -v --rmi all; \
		rm -rf logs; \
		echo "清理完成"; \
	else \
		echo "已取消"; \
	fi

# 测试服务健康状态
test:
	@echo "测试服务健康状态..."
	@curl -sf http://localhost:3000/ > /dev/null && echo "✓ 健康检查通过" || (echo "✗ 健康检查失败" && exit 1)
	@curl -sf http://localhost:3000/v1/models > /dev/null && echo "✓ API 端点正常" || (echo "✗ API 端点异常" && exit 1)
	@echo "所有测试通过！"

# 一键部署
deploy: build up
	@echo "等待服务启动..."
	@sleep 10
	@make test
	@echo "部署完成！"

# 一键生产部署
deploy-prod: build-prod up-prod
	@echo "等待服务启动..."
	@sleep 10
	@make test
	@echo "生产环境部署完成！"

# 查看容器资源使用情况
stats:
	docker stats omni --no-stream

# 备份日志
backup-logs:
	@echo "备份日志..."
	@tar -czf logs-backup-$$(date +%Y%m%d-%H%M%S).tar.gz logs/
	@echo "日志已备份到 logs-backup-$$(date +%Y%m%d-%H%M%S).tar.gz"

# 更新部署（零停机）
update:
	@echo "开始零停机更新..."
	docker-compose build
	docker-compose up -d --no-deps --scale omni=2 omni
	@sleep 5
	docker-compose up -d --no-deps --scale omni=1 omni
	@echo "更新完成"
