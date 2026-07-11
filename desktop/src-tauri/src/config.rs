use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopConfig {
    pub port: u16,
    pub host: String,
    pub onboarding_completed: bool,
    pub launch_at_login: bool,
    pub close_to_tray: bool,
    pub auto_start_core: bool,
    /// Admin API key used by desktop shell to call /admin/api/*
    #[serde(default)]
    pub admin_api_key: String,
}

impl Default for DesktopConfig {
    fn default() -> Self {
        Self {
            port: 3000,
            host: "127.0.0.1".into(),
            onboarding_completed: false,
            launch_at_login: false,
            close_to_tray: true,
            auto_start_core: true,
            admin_api_key: String::new(),
        }
    }
}

fn config_path() -> PathBuf {
    let dir = dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("OmniAPI");
    let _ = fs::create_dir_all(&dir);
    dir.join("desktop.json")
}

pub fn load_config() -> DesktopConfig {
    let path = config_path();
    match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => DesktopConfig::default(),
    }
}

pub fn save_config(cfg: &DesktopConfig) -> Result<(), String> {
    let path = config_path();
    let raw = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(path, raw).map_err(|e| e.to_string())
}
