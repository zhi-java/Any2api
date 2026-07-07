@echo off
REM 快速启动脚本 - Windows 版本
setlocal enabledelayedexpansion

echo === OmniAPI 快速启动 ===
echo.

REM 检查 .env 文件
if not exist .env (
    echo [提示] 未找到 .env 文件，从模板创建...
    if exist .env.docker (
        copy .env.docker .env >nul
        echo [成功] 已创建 .env 文件
        echo [警告] 请编辑 .env 文件，配置必要的认证信息后重新运行
        pause
        exit /b 1
    ) else (
        echo [错误] 未找到 .env.docker 模板
        pause
        exit /b 1
    )
)

REM 检查 Docker
docker --version >nul 2>&1
if errorlevel 1 (
    echo [错误] 未安装 Docker
    pause
    exit /b 1
)

REM 检查 Docker Compose
docker compose version >nul 2>&1
if not errorlevel 1 (
    set COMPOSE_CMD=docker compose
) else (
    docker-compose --version >nul 2>&1
    if not errorlevel 1 (
        set COMPOSE_CMD=docker-compose
    ) else (
        echo [错误] 未安装 Docker Compose
        pause
        exit /b 1
    )
)

echo [检查] 检查环境...

REM 停止旧容器
docker ps -a | findstr /C:"omni" >nul 2>&1
if not errorlevel 1 (
    echo [提示] 停止旧容器...
    %COMPOSE_CMD% down
)

REM 构建并启动
echo [构建] 构建镜像...
%COMPOSE_CMD% build
if errorlevel 1 (
    echo [错误] 镜像构建失败
    pause
    exit /b 1
)

echo [启动] 启动服务...
%COMPOSE_CMD% up -d
if errorlevel 1 (
    echo [错误] 服务启动失败
    pause
    exit /b 1
)

REM 等待服务就绪
echo [等待] 等待服务启动...
timeout /t 5 /nobreak >nul

set MAX_ATTEMPTS=30
set ATTEMPT=0

:wait_loop
if %ATTEMPT% geq %MAX_ATTEMPTS% (
    echo.
    echo [错误] 服务启动超时
    echo [日志] 最近 50 行日志：
    %COMPOSE_CMD% logs --tail=50
    pause
    exit /b 1
)

curl -sf http://localhost:3000/ >nul 2>&1
if not errorlevel 1 (
    echo.
    echo [成功] 服务已启动
    echo.
    echo 服务信息：
    echo   健康检查: http://localhost:3000/
    echo   管理面板: http://localhost:3000/admin
    echo   性能监控: http://localhost:3000/performance
    echo.
    echo 常用命令：
    echo   查看日志: docker-compose logs -f
    echo   停止服务: docker-compose down
    echo   重启服务: docker-compose restart
    echo   查看状态: docker-compose ps
    echo.
    pause
    exit /b 0
)

set /a ATTEMPT+=1
echo | set /p=.
timeout /t 2 /nobreak >nul
goto wait_loop

endlocal
