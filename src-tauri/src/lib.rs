use std::sync::Mutex;

use tauri::{Manager, WindowEvent};
use tauri_plugin_shell::{process::CommandEvent, ShellExt};

struct DesktopService {
    child: Mutex<Option<tauri_plugin_shell::process::CommandChild>>,
}

const READY_PREFIX: &str = "ZHI2API_READY:";

fn stop_desktop_service(app_handle: &tauri::AppHandle) {
    let state = app_handle.state::<DesktopService>();
    {
        if let Ok(mut child) = state.child.lock() {
            if let Some(child) = child.take() {
                let _ = child.kill();
            }
        }
    };
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let (mut rx, child) = app
                .shell()
                .sidecar("zhi2api-sidecar")?
                .env("HOST", "127.0.0.1")
                .env("PORT", "0")
                .spawn()?;

            app.manage(DesktopService {
                child: Mutex::new(Some(child)),
            });

            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(bytes) => {
                            let text = String::from_utf8_lossy(&bytes);
                            print!("{text}");

                            for line in text.lines() {
                                let Some(port) = line.trim().strip_prefix(READY_PREFIX) else {
                                    continue;
                                };

                                let url = format!("http://127.0.0.1:{}/admin", port.trim());
                                let Some(window) = app_handle.get_webview_window("main") else {
                                    continue;
                                };

                                match url.parse() {
                                    Ok(url) => {
                                        if let Err(error) = window.navigate(url) {
                                            eprintln!("Failed to navigate zhi2Api window: {error}");
                                        }
                                        let _ = window.show();
                                        let _ = window.set_focus();
                                    }
                                    Err(error) => {
                                        eprintln!("Invalid zhi2Api admin URL {url}: {error}");
                                    }
                                }
                            }
                        }
                        CommandEvent::Stderr(bytes) => {
                            let text = String::from_utf8_lossy(&bytes);
                            eprint!("{text}");
                        }
                        CommandEvent::Terminated(payload) => {
                            eprintln!("zhi2Api service exited: {payload:?}");
                            break;
                        }
                        _ => {}
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::CloseRequested { .. }) {
                stop_desktop_service(&window.app_handle());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
