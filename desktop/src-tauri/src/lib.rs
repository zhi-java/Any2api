mod admin;
mod config;
mod gateway;

use admin::AdminClient;
use config::{load_config, save_config, DesktopConfig};
use gateway::{CoreManager, CoreStatus, CoreState, SharedCore};
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    path::BaseDirectory,
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_notification::NotificationExt;
use tokio::time::{sleep, Duration};

struct AppState {
    core: SharedCore,
    config: parking_lot::Mutex<DesktopConfig>,
    tray: parking_lot::Mutex<Option<TrayIcon>>,
    tray_status_item: parking_lot::Mutex<Option<MenuItem<tauri::Wry>>>,
    last_notified_state: parking_lot::Mutex<Option<CoreState>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShellInfo {
    version: String,
    repo_root: String,
    onboarding_completed: bool,
    config: DesktopConfig,
    core: CoreStatus,
    launch_at_login_enabled: bool,
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .canonicalize()
        .unwrap_or_else(|_| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("..")
        })
}

fn is_autostart_enabled(app: &AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

fn apply_autostart(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    let currently = manager.is_enabled().unwrap_or(false);
    if enabled && !currently {
        manager.enable().map_err(|e| e.to_string())?;
    } else if !enabled && currently {
        manager.disable().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn status_menu_label(status: &CoreStatus) -> String {
    let icon = match status.state {
        CoreState::Running => "●",
        CoreState::Degraded | CoreState::Starting => "◐",
        CoreState::Crashed => "✕",
        CoreState::Stopped => "○",
    };
    format!("{} {}", icon, status.message)
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    let _ = app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .show();
}

fn maybe_notify_state_change(app: &AppHandle, status: &CoreStatus) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let mut prev = state.last_notified_state.lock();
    let previous = prev.clone();
    if previous.as_ref() == Some(&status.state) {
        return;
    }

    match (&previous, &status.state) {
        (Some(p), CoreState::Crashed) if *p != CoreState::Crashed => {
            let detail = status
                .last_error
                .as_deref()
                .unwrap_or("进程异常退出，正在尝试自动重启");
            notify(app, "OmniAPI · 网关已崩溃", detail);
        }
        (Some(CoreState::Crashed), CoreState::Running)
        | (Some(CoreState::Degraded), CoreState::Running) => {
            notify(
                app,
                "OmniAPI · 网关已恢复",
                &format!("服务已回到运行中 · {}", status.endpoint),
            );
        }
        (Some(CoreState::Running), CoreState::Degraded) => {
            notify(
                app,
                "OmniAPI · 网关需关注",
                "健康检查暂时失败，请查看面板状态",
            );
        }
        _ => {}
    }

    *prev = Some(status.state.clone());
}

#[tauri::command]
fn get_shell_info(app: AppHandle, state: State<'_, AppState>) -> ShellInfo {
    let cfg = state.config.lock().clone();
    let core = state.core.status(&cfg);
    ShellInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        repo_root: repo_root().display().to_string(),
        onboarding_completed: cfg.onboarding_completed,
        config: cfg,
        core,
        launch_at_login_enabled: is_autostart_enabled(&app),
    }
}

#[tauri::command]
fn get_core_status(state: State<'_, AppState>) -> CoreStatus {
    let cfg = state.config.lock().clone();
    state.core.tick(&cfg)
}

#[tauri::command]
fn get_config(state: State<'_, AppState>) -> DesktopConfig {
    state.config.lock().clone()
}

#[tauri::command]
fn update_config(
    app: AppHandle,
    state: State<'_, AppState>,
    patch: DesktopConfig,
) -> Result<DesktopConfig, String> {
    apply_autostart(&app, patch.launch_at_login)?;
    save_config(&patch)?;
    *state.config.lock() = patch.clone();
    Ok(patch)
}

#[tauri::command]
fn complete_onboarding(state: State<'_, AppState>) -> Result<DesktopConfig, String> {
    let mut cfg = state.config.lock().clone();
    cfg.onboarding_completed = true;
    save_config(&cfg)?;
    *state.config.lock() = cfg.clone();
    Ok(cfg)
}

#[tauri::command]
fn set_launch_at_login(
    app: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<DesktopConfig, String> {
    apply_autostart(&app, enabled)?;
    let mut cfg = state.config.lock().clone();
    cfg.launch_at_login = enabled;
    save_config(&cfg)?;
    *state.config.lock() = cfg.clone();
    Ok(cfg)
}

#[tauri::command]
fn get_launch_at_login(app: AppHandle) -> bool {
    is_autostart_enabled(&app)
}

#[tauri::command]
fn open_admin(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let cfg = state.config.lock().clone();
    let url = format!("http://{}:{}/admin", cfg.host, cfg.port);
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
        let js = format!("window.location.href = {}", serde_json::to_string(&url).unwrap());
        let _ = win.eval(&js);
    }
    Ok(())
}

#[tauri::command]
fn copy_endpoint(state: State<'_, AppState>) -> Result<String, String> {
    let cfg = state.config.lock().clone();
    Ok(format!("http://{}:{}/v1", cfg.host, cfg.port))
}

#[tauri::command]
fn set_admin_api_key(state: State<'_, AppState>, api_key: String) -> Result<DesktopConfig, String> {
    let mut cfg = state.config.lock().clone();
    cfg.admin_api_key = api_key.trim().to_string();
    if !cfg.admin_api_key.is_empty() {
        let _ = AdminClient::login(&cfg, &cfg.admin_api_key);
    }
    save_config(&cfg)?;
    *state.config.lock() = cfg.clone();
    Ok(cfg)
}

#[tauri::command]
fn admin_login(state: State<'_, AppState>, api_key: String) -> Result<Value, String> {
    let mut cfg = state.config.lock().clone();
    let result = AdminClient::login(&cfg, &api_key)?;
    cfg.admin_api_key = api_key.trim().to_string();
    save_config(&cfg)?;
    *state.config.lock() = cfg;
    Ok(result)
}

#[tauri::command]
fn admin_auth_status(state: State<'_, AppState>) -> Result<Value, String> {
    let cfg = state.config.lock().clone();
    let key = if cfg.admin_api_key.is_empty() {
        None
    } else {
        Some(cfg.admin_api_key.as_str())
    };
    AdminClient::request(&cfg, "GET", "/admin/api/auth/status", None, key)
}

#[tauri::command]
fn add_channel_credential(
    state: State<'_, AppState>,
    channel: String,
    payload: Value,
) -> Result<Value, String> {
    let cfg = state.config.lock().clone();
    let key = if cfg.admin_api_key.is_empty() {
        None
    } else {
        Some(cfg.admin_api_key.as_str())
    };
    AdminClient::add_credential(&cfg, &channel, payload, key)
}

#[tauri::command]
fn test_channel(state: State<'_, AppState>, channel: String) -> Result<Value, String> {
    let cfg = state.config.lock().clone();
    let key = if cfg.admin_api_key.is_empty() {
        None
    } else {
        Some(cfg.admin_api_key.as_str())
    };
    AdminClient::test_channel(&cfg, &channel, key)
}

#[tauri::command]
fn get_admin_health(state: State<'_, AppState>) -> Result<Value, String> {
    let cfg = state.config.lock().clone();
    let key = if cfg.admin_api_key.is_empty() {
        None
    } else {
        Some(cfg.admin_api_key.as_str())
    };
    AdminClient::health(&cfg, key)
}

fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

fn tray_icon_bytes(state: &CoreState) -> &'static [u8] {
    match state {
        CoreState::Running => include_bytes!("../icons/tray-ok.png"),
        CoreState::Degraded | CoreState::Starting => include_bytes!("../icons/tray-warn.png"),
        CoreState::Crashed => include_bytes!("../icons/tray-bad.png"),
        CoreState::Stopped => include_bytes!("../icons/tray-idle.png"),
    }
}

fn tray_icon_image(state: &CoreState) -> Option<Image<'static>> {
    Image::from_bytes(tray_icon_bytes(state)).ok()
}

fn update_tray_visual(app: &AppHandle, status: &CoreStatus) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Some(tray) = state.tray.lock().as_ref() {
            let tip = format!("OmniAPI · {}", status.message);
            let _ = tray.set_tooltip(Some(tip));
            if let Some(icon) = tray_icon_image(&status.state) {
                let _ = tray.set_icon(Some(icon));
            }
        }
        if let Some(item) = state.tray_status_item.lock().as_ref() {
            let _ = item.set_text(status_menu_label(status));
        }
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let cfg = app
        .try_state::<AppState>()
        .map(|s| s.config.lock().clone())
        .unwrap_or_default();
    let initial = app
        .try_state::<AppState>()
        .map(|s| s.core.status(&cfg))
        .unwrap_or_else(|| CoreStatus {
            state: CoreState::Stopped,
            port: cfg.port,
            host: cfg.host.clone(),
            endpoint: format!("http://{}:{}/v1", cfg.host, cfg.port),
            admin_url: format!("http://{}:{}/admin", cfg.host, cfg.port),
            pid: None,
            last_error: None,
            health_ok: false,
            message: "已停止".into(),
        });

    let status_i = MenuItem::with_id(
        app,
        "status",
        status_menu_label(&initial),
        false,
        None::<&str>,
    )?;
    let open_i = MenuItem::with_id(app, "open", "打开面板", true, None::<&str>)?;
    let copy_i = MenuItem::with_id(app, "copy", "复制 API 地址", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &status_i,
            &sep,
            &open_i,
            &copy_i,
            &quit_i,
        ],
    )?;

    let tray_icon = tray_icon_image(&initial.state)
        .or_else(|| app.default_window_icon().cloned())
        .expect("missing tray icon");

    let tray = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip(format!("OmniAPI · {}", initial.message))
        .icon(tray_icon)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "copy" => {
                if let Some(state) = app.try_state::<AppState>() {
                    let cfg = state.config.lock().clone();
                    let endpoint = format!("http://{}:{}/v1", cfg.host, cfg.port);
                    if let Some(win) = app.get_webview_window("main") {
                        let encoded =
                            serde_json::to_string(&endpoint).unwrap_or_else(|_| "\"\"".to_string());
                        let js = format!(
                            "navigator.clipboard && navigator.clipboard.writeText({})",
                            encoded
                        );
                        let _ = win.eval(&js);
                    }
                    let _ = app.emit("endpoint-copied", endpoint);
                }
            }
            "quit" => {
                // 停止核心可能耗时数百毫秒：先隐藏窗口给出即时反馈，
                // 清理放后台线程，避免托盘菜单线程卡住。
                let handle = app.clone();
                if let Some(win) = handle.get_webview_window("main") {
                    let _ = win.hide();
                }
                std::thread::spawn(move || {
                    if let Some(state) = handle.try_state::<AppState>() {
                        let cfg = state.config.lock().clone();
                        let _ = state.core.stop(&cfg);
                    }
                    handle.exit(0);
                });
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;

    if let Some(state) = app.try_state::<AppState>() {
        *state.tray.lock() = Some(tray);
        *state.tray_status_item.lock() = Some(status_i);
    }
    Ok(())
}

fn wire_resource_dir(app: &AppHandle, core: &CoreManager) {
    if let Ok(dir) = app.path().resolve("", BaseDirectory::Resource) {
        core.set_resource_dir(Some(dir));
        return;
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
    if dev.exists() {
        core.set_resource_dir(Some(dev));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cfg = load_config();
    let core = Arc::new(CoreManager::new(repo_root()));

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
            notify(app, "OmniAPI", "已在运行，已唤起主面板");
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .manage(AppState {
            core: core.clone(),
            config: parking_lot::Mutex::new(cfg.clone()),
            tray: parking_lot::Mutex::new(None),
            tray_status_item: parking_lot::Mutex::new(None),
            last_notified_state: parking_lot::Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            get_shell_info,
            get_core_status,
            get_config,
            update_config,
            complete_onboarding,
            set_launch_at_login,
            get_launch_at_login,
            open_admin,
            copy_endpoint,
            set_admin_api_key,
            admin_login,
            admin_auth_status,
            add_channel_credential,
            test_channel,
            get_admin_health,
        ])
        .setup(move |app| {
            wire_resource_dir(app.handle(), &core);
            apply_window_icon(app.handle());

            let _ = apply_autostart(app.handle(), cfg.launch_at_login);

            build_tray(app.handle())?;

            if cfg.auto_start_core {
                // 核心启动最长要等 30s 健康检查——放到后台线程，
                // 否则 setup 阻塞、窗口白屏到核心就绪为止。
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let Some(state) = handle.try_state::<AppState>() else {
                        return;
                    };
                    let c = state.config.lock().clone();
                    match state.core.start(&c) {
                        Ok(status) => {
                            *state.last_notified_state.lock() = Some(status.state.clone());
                            update_tray_visual(&handle, &status);
                            let _ = handle.emit("core-status", status);
                        }
                        Err(e) => eprintln!("[desktop] core start failed: {e}"),
                    }
                });
            }

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    sleep(Duration::from_secs(3)).await;
                    if let Some(state) = handle.try_state::<AppState>() {
                        let c = state.config.lock().clone();
                        let status = state.core.tick(&c);
                        update_tray_visual(&handle, &status);
                        maybe_notify_state_change(&handle, &status);
                        let _ = handle.emit("core-status", status);
                    }
                }
            });

            if let Some(win) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                win.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        let close_to_tray = handle
                            .try_state::<AppState>()
                            .map(|s| s.config.lock().close_to_tray)
                            .unwrap_or(true);
                        if close_to_tray {
                            api.prevent_close();
                            if let Some(w) = handle.get_webview_window("main") {
                                let _ = w.hide();
                            }
                        }
                    }
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running OmniAPI desktop")
        .run(|app_handle, event| {
            // 兜底所有退出路径（关窗退出、app.exit、系统注销等）：
            // 核心子进程仍在时同步停掉，避免残留 node.exe 占用端口。
            // stop() 对已停止状态是快速幂等的，托盘退出线程先停过也不会重复付出代价。
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    if state.core.has_child() {
                        let cfg = state.config.lock().clone();
                        let _ = state.core.stop(&cfg);
                    }
                }
            }
        });
}

fn apply_window_icon(app: &AppHandle) {
    if let Some(icon) = Image::from_bytes(include_bytes!("../icons/icon.png")).ok() {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.set_icon(icon);
        }
    }
}
