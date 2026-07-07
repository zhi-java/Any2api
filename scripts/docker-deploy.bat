@echo off
REM Docker 部署脚本 - Windows 版本
setlocal enabledelayedexpansion

REM 配置
set IMAGE_NAME=omni
set CONTAINER_NAME=omni
set ENV_FILE=.env

echo [INFO] 开始 Docker 部署流程

REM 检查 Docker 是否安装
docker --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] 未检测到 Docker，请先安装 Docker
    exit /b 1
)

REM 检查环境配置文件
if not exist "%ENV_FILE%" (
    echo [ERROR] 未找到 %ENV_FILE% 文件
    echo [INFO] 请复制 .env.docker 为 .env 并配置必要的环境变量
    exit /b 1
)

echo [INFO] 环境配置检查通过

REM 构建镜像
echo [INFO] 开始构建 Docker 镜像...
docker build -t %IMAGE_NAME%:latest .
if errorlevel 1 (
    echo [ERROR] 镜像构建失败
    exit /b 1
)
echo [INFO] 镜像构建完成

REM 停止旧容器
docker ps -a | findstr /C:"%CONTAINER_NAME%" >nul 2>&1
if not errorlevel 1 (
    echo [INFO] 停止旧容器...
    docker stop %CONTAINER_NAME% 2>nul
    docker rm %CONTAINER_NAME% 2>nul
)

REM 读取端口配置
for /f "tokens=2 delims==" %%i in ('findstr /B "PORT=" "%ENV_FILE%"') do set PORT=%%i
if "%PORT%"=="" set PORT=3000

REM 启动容器
echo [INFO] 启动新容器...
docker run -d ^
    --name %CONTAINER_NAME% ^
    -p %PORT%:3000 ^
    --env-file %ENV_FILE% ^
    -v "%cd%\logs:/app/logs" ^
    --restart unless-stopped ^
    %IMAGE_NAME%:latest

if errorlevel 1 (
    echo [ERROR] 容器启动失败
    exit /b 1
)

echo [INFO] 容器已启动

REM 等待服务就绪
echo [INFO] 等待服务就绪...
set MAX_ATTEMPTS=30
set ATTEMPT=0

:wait_loop
if %ATTEMPT% geq %MAX_ATTEMPTS% (
    echo.
    echo [ERROR] 服务启动超时
    docker logs %CONTAINER_NAME%
    exit /b 1
)

curl -sf "http://localhost:%PORT%/" >nul 2>&1
if not errorlevel 1 (
    echo.
    echo [INFO] 服务已就绪
    goto service_ready
)

set /a ATTEMPT+=1
echo | set /p=.
timeout /t 2 /nobreak >nul
goto wait_loop

:service_ready
REM 显示状态
echo [INFO] 服务状态：
docker ps | findstr %CONTAINER_NAME%

echo.
echo [INFO] 服务地址：
echo   健康检查: http://localhost:%PORT%/
echo   管理面板: http://localhost:%PORT%/admin
echo   性能监控: http://localhost:%PORT%/performance

echo.
echo [INFO] 部署完成！

endlocal
