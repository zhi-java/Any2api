# OmniAPI Desktop (Tauri)

轻量桌面壳：**托盘控制台 + 首启向导 + 本机 Core 生命周期**。  
UI 体系：S4 Soft Product。体积上相对 Electron 更小（系统 WebView，不内嵌 Chromium）。

## 架构

```
Desktop Shell (Tauri)
  tray / wizard / home / start-stop Core
        |
        v
OmniAPI Core  (node src/index.js)
  /v1  /admin  /healthz
```

## 开发

前置：

- Node.js 18+
- Rust stable（已装 rustc/cargo）
- Windows：WebView2（Win11 自带）

```bash
# 仓库根目录
cd desktop
npm install
npm run dev
```

首次 `tauri dev` 会编译 Rust 依赖，可能需几分钟。

## 行为

| 操作 | 行为 |
|------|------|
| 启动 App | 自动启动 Core（若 /healthz 未就绪） |
| 二次启动 | 单实例锁：唤起已有主窗 + 系统通知 |
| 关闭主窗 | 隐藏到托盘，Core 不停 |
| 托盘退出 | 停止 Core 后退出 |
| 首启 | 向导（含凭据保存/测通）；完成后写 `%AppData%/OmniAPI/desktop.json` |
| 打开控制台 | 主窗跳转 `http://127.0.0.1:3000/admin` |
| 开机自启 | 首页开关；写入系统自启 + launchAtLogin |
| Core 崩溃/恢复 | 系统通知（仅状态跃迁时触发，手动停止不告警） |

## 托盘

- 状态行：运行中 / 需关注 / 已停止 / 已崩溃
- 图标色：绿 / 黄 / 灰 / 红（icons/tray-*.png）
- 菜单：打开面板 · 复制 API · 启动/停止 · 重启 · 退出

## 脚本

| 命令 | 说明 |
|------|------|
| npm run dev | 开发模式 |
| npm run build | 打 NSIS 安装包（src-tauri/target/release/bundle） |

## 配置

`%AppData%/OmniAPI/desktop.json`：

```json
{
  "port": 3000,
  "host": "127.0.0.1",
  "onboardingCompleted": false,
  "launchAtLogin": false,
  "closeToTray": true,
  "autoStartCore": true,
  "adminApiKey": ""
}
```

## 已实现

- 托盘菜单 + 动态状态文案/图标
- Core start/stop/restart + health 轮询 + 有限次自动重启
- 关窗进托盘
- S4 首启向导（渠道选择 / 凭据 / 测通 / Endpoint）
- 首页开机自启开关（tauri-plugin-autostart）
- 单实例锁（tauri-plugin-single-instance）
- 崩溃 / 降级 / 恢复系统通知（tauri-plugin-notification）
- 跳转现有 Admin SPA

## 打包与 Core 捆绑

安装包会附带 `omniapi-core(.exe)`（由 `@yao-pkg/pkg` 从仓库 Core 打出），终端用户**不需要**本机 Node。

```bash
# 仅预编译 Core 二进制 → desktop/src-tauri/resources/
npm run prepare:core
# 或强制重打
npm run prepare:core:force

# 完整桌面安装包（beforeBuildCommand 会先 prepare-core）
npm run build
```

启动优先级：

1. 环境变量 `OMNIAPI_CORE_BIN`
2. 安装包 resource 目录 / 可执行文件旁的 `omniapi-core(.exe)`
3. 开发态：`node <repo>/src/index.js`

Core 数据目录：`%AppData%/OmniAPI`（`ZHI2API_DATA_DIR`）。

## 后续

- 安装包体验与卸载清理
- macOS / Linux 目标验证
