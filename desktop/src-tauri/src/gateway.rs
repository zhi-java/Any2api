use crate::config::DesktopConfig;
use parking_lot::Mutex;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CoreState {
    Stopped,
    Starting,
    Running,
    Degraded,
    Crashed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreStatus {
    pub state: CoreState,
    pub port: u16,
    pub host: String,
    pub endpoint: String,
    pub admin_url: String,
    pub pid: Option<u32>,
    pub last_error: Option<String>,
    pub health_ok: bool,
    pub message: String,
}

struct Inner {
    child: Option<Child>,
    state: CoreState,
    last_error: Option<String>,
    started_at: Option<Instant>,
    restart_attempts: u32,
    intentional_stop: bool,
}

pub struct CoreManager {
    inner: Mutex<Inner>,
    /// Repo root (dev) — used for `node src/index.js`.
    repo_root: PathBuf,
    /// Tauri resource dir (packaged) — may contain `omniapi-core(.exe)`.
    resource_dir: Mutex<Option<PathBuf>>,
}

impl CoreManager {
    pub fn new(repo_root: PathBuf) -> Self {
        Self {
            inner: Mutex::new(Inner {
                child: None,
                state: CoreState::Stopped,
                last_error: None,
                started_at: None,
                restart_attempts: 0,
                intentional_stop: false,
            }),
            repo_root,
            resource_dir: Mutex::new(None),
        }
    }

    pub fn set_resource_dir(&self, dir: Option<PathBuf>) {
        *self.resource_dir.lock() = dir;
    }

    pub fn status(&self, cfg: &DesktopConfig) -> CoreStatus {
        let g = self.inner.lock();
        self.status_unlocked(cfg, &g)
    }

    pub fn start(&self, cfg: &DesktopConfig) -> Result<CoreStatus, String> {
        {
            let mut g = self.inner.lock();
            if let Some(child) = g.child.as_mut() {
                match child.try_wait() {
                    Ok(None) => {
                        g.state = CoreState::Starting;
                        return Ok(self.status_unlocked(cfg, &g));
                    }
                    Ok(Some(_)) | Err(_) => {
                        g.child = None;
                    }
                }
            }
            g.intentional_stop = false;
            g.state = CoreState::Starting;
            g.last_error = None;
        }

        // If something already answers healthz, don't double-start.
        if healthz_sync(cfg).unwrap_or(false) {
            let mut g = self.inner.lock();
            g.state = CoreState::Running;
            g.started_at = Some(Instant::now());
            return Ok(self.status_unlocked(cfg, &g));
        }

        let launch = resolve_launch(&self.repo_root, self.resource_dir.lock().clone())?;
        let data_dir = data_dir();
        let _ = std::fs::create_dir_all(&data_dir);

        let mut cmd = Command::new(&launch.program);
        for a in &launch.args {
            cmd.arg(a);
        }
        cmd.current_dir(&launch.cwd)
            .env("PORT", cfg.port.to_string())
            .env("HOST", &cfg.host)
            .env("ZHI2API_DATA_DIR", &data_dir)
            .stdout(Stdio::null())
            .stderr(Stdio::piped());

        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let child = cmd.spawn().map_err(|e| {
            format!(
                "无法启动 Core ({} {}): {}",
                launch.program.display(),
                launch.args.join(" "),
                e
            )
        })?;

        let mut g = self.inner.lock();
        g.child = Some(child);
        g.state = CoreState::Starting;
        g.started_at = Some(Instant::now());
        g.restart_attempts = 0;
        Ok(self.status_unlocked(cfg, &g))
    }

    pub fn stop(&self, cfg: &DesktopConfig) -> Result<CoreStatus, String> {
        let mut g = self.inner.lock();
        g.intentional_stop = true;
        if let Some(child) = g.child.take() {
            let pid = child.id();

            // Preferred: kill the child process.
            // On Windows, child.kill() calls TerminateProcess.
            // As a belt-and-suspenders measure, also issue
            // `taskkill /T /PID <pid>` to terminate the full process tree
            // including any JS child workers or npm subprocesses.
            let _ = self.child_kill_with_tree(pid, true);

            // Wait the child we spawned so its zombie is reaped.
            // Killing a process tree may have already killed this child,
            // but we still need the parent Child handle finalised.
            let _ = self.wait_child(child);
        }
        g.state = CoreState::Stopped;
        g.last_error = None;
        Ok(self.status_unlocked(cfg, &g))
    }

    #[cfg(windows)]
    fn child_kill_with_tree(&self, pid: u32, graceful: bool) -> std::io::Result<()> {
        use std::process::Command;
        if graceful {
            // Send Ctrl-C-ish close then escalate to termination.
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string()])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            std::thread::sleep(Duration::from_millis(200));
        }
        let status = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?;
        if !status.success() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("taskkill /T failed with {}", status),
            ));
        }
        Ok(())
    }

    #[cfg(not(windows))]
    fn child_kill_with_tree(&self, pid: u32, _graceful: bool) -> std::io::Result<()> {
        use std::process::Command;
        // Unix: kill process group (-pid).
        let _ = Command::new("kill")
            .args(["-TERM", &format!("-{}", pid)])
            .status();
        std::thread::sleep(Duration::from_millis(200));
        let _ = Command::new("kill")
            .args(["-KILL", &format!("-{}", pid)])
            .status();
        Ok(())
    }

    fn wait_child(&self, mut child: Child) {
        // Try a brief wait first; if that times out the process was
        // killed externally and we can stop.
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(5) {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => std::thread::sleep(Duration::from_millis(100)),
                Err(_) => return,
            }
        }
        let _ = child.kill();
    }

    pub fn restart(&self, cfg: &DesktopConfig) -> Result<CoreStatus, String> {
        let _ = self.stop(cfg);
        std::thread::sleep(Duration::from_millis(400));
        self.start(cfg)
    }

    /// Poll child + health endpoint; update state; maybe auto-restart.
    pub fn tick(&self, cfg: &DesktopConfig) -> CoreStatus {
        {
            let mut g = self.inner.lock();
            if let Some(child) = g.child.as_mut() {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        g.child = None;
                        if !g.intentional_stop {
                            g.state = CoreState::Crashed;
                            g.last_error = Some(format!("Core 退出: {status}"));
                        } else {
                            g.state = CoreState::Stopped;
                        }
                    }
                    Ok(None) => {}
                    Err(e) => {
                        g.last_error = Some(e.to_string());
                    }
                }
            }
        }

        let healthy = healthz_sync(cfg).unwrap_or(false);
        {
            let mut g = self.inner.lock();
            if healthy {
                g.state = CoreState::Running;
                g.restart_attempts = 0;
            } else if matches!(g.state, CoreState::Starting) {
                if let Some(at) = g.started_at {
                    if at.elapsed() > Duration::from_secs(45) {
                        g.state = CoreState::Crashed;
                        g.last_error = Some("启动超时：/healthz 无响应".into());
                    }
                }
            } else if matches!(g.state, CoreState::Running | CoreState::Degraded) {
                g.state = CoreState::Degraded;
            }
        }

        let should_restart = {
            let g = self.inner.lock();
            !g.intentional_stop
                && matches!(g.state, CoreState::Crashed)
                && g.restart_attempts < 5
                && cfg.auto_start_core
        };
        if should_restart {
            {
                let mut g = self.inner.lock();
                g.restart_attempts += 1;
            }
            let _ = self.start(cfg);
        }

        let g = self.inner.lock();
        self.status_unlocked(cfg, &g)
    }

    fn status_unlocked(&self, cfg: &DesktopConfig, g: &Inner) -> CoreStatus {
        let endpoint = format!("http://{}:{}/v1", cfg.host, cfg.port);
        let admin_url = format!("http://{}:{}/admin", cfg.host, cfg.port);
        let pid = g.child.as_ref().map(|c| c.id());
        let message = match g.state {
            CoreState::Stopped => "已停止".into(),
            CoreState::Starting => "正在启动…".into(),
            CoreState::Running => "运行中".into(),
            CoreState::Degraded => "需关注".into(),
            CoreState::Crashed => "已崩溃，准备重启".into(),
        };
        CoreStatus {
            state: g.state.clone(),
            port: cfg.port,
            host: cfg.host.clone(),
            endpoint,
            admin_url,
            pid,
            last_error: g.last_error.clone(),
            health_ok: matches!(g.state, CoreState::Running | CoreState::Degraded),
            message,
        }
    }
}

struct LaunchSpec {
    program: PathBuf,
    args: Vec<String>,
    cwd: PathBuf,
}

fn core_bin_name() -> &'static str {
    if cfg!(windows) {
        "omniapi-core.exe"
    } else {
        "omniapi-core"
    }
}

fn data_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("OmniAPI")
}

fn resolve_launch(repo_root: &Path, resource_dir: Option<PathBuf>) -> Result<LaunchSpec, String> {
    // 1) Explicit override
    if let Ok(bin) = std::env::var("OMNIAPI_CORE_BIN") {
        let p = PathBuf::from(bin);
        if p.exists() {
            return Ok(LaunchSpec {
                program: p,
                args: vec![],
                cwd: data_dir(),
            });
        }
    }

    // 2) Single-file Core binary in packaged resource dir / next to desktop exe.
    let mut binary_candidates: Vec<PathBuf> = Vec::new();
    let mut portable_candidates: Vec<(PathBuf, PathBuf, PathBuf)> = Vec::new();
    if let Some(rd) = resource_dir {
        binary_candidates.push(rd.join(core_bin_name()));
        binary_candidates.push(rd.join("core").join(core_bin_name()));
        portable_candidates.push((
            rd.join("node").join(if cfg!(windows) { "node.exe" } else { "node" }),
            rd.join("core").join("src").join("index.js"),
            rd.join("core"),
        ));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            binary_candidates.push(dir.join(core_bin_name()));
            binary_candidates.push(dir.join("resources").join(core_bin_name()));
            portable_candidates.push((
                dir.join("resources")
                    .join("node")
                    .join(if cfg!(windows) { "node.exe" } else { "node" }),
                dir.join("resources")
                    .join("core")
                    .join("src")
                    .join("index.js"),
                dir.join("resources").join("core"),
            ));
        }
    }
    // Dev convenience: prebuilt under desktop/src-tauri/resources.
    let dev_resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
    binary_candidates.push(dev_resources.join(core_bin_name()));
    portable_candidates.push((
        dev_resources
            .join("node")
            .join(if cfg!(windows) { "node.exe" } else { "node" }),
        dev_resources.join("core").join("src").join("index.js"),
        dev_resources.join("core"),
    ));

    for c in binary_candidates {
        if c.exists() {
            return Ok(LaunchSpec {
                program: c,
                args: vec![],
                cwd: data_dir(),
            });
        }
    }

    // 3) Portable Node runtime staged by desktop/scripts/prepare-core.mjs.
    for (node, entry, cwd) in portable_candidates {
        if node.exists() && entry.exists() {
            return Ok(LaunchSpec {
                program: node,
                args: vec![entry.display().to_string()],
                cwd,
            });
        }
    }

    // 4) Dev fallback: system node + repo entry.
    let entry = resolve_core_entry(repo_root)?;
    Ok(LaunchSpec {
        program: PathBuf::from("node"),
        args: vec![entry.display().to_string()],
        cwd: repo_root.to_path_buf(),
    })
}

fn healthz_sync(cfg: &DesktopConfig) -> Result<bool, String> {
    let url = format!("http://{}:{}/healthz", cfg.host, cfg.port);
    ureq_get(&url)
}

fn ureq_get(url: &str) -> Result<bool, String> {
    use std::io::{Read, Write};
    use std::net::TcpStream;

    let host_port = url
        .trim_start_matches("http://")
        .trim_start_matches("https://");
    let (host, path) = host_port
        .split_once('/')
        .map(|(h, p)| (h, format!("/{p}")))
        .unwrap_or((host_port, "/".into()));

    let mut stream = TcpStream::connect(host).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_millis(800)))
        .ok();
    stream
        .set_write_timeout(Some(Duration::from_millis(800)))
        .ok();
    let req = format!("GET {path} HTTP/1.0\r\nHost: {host}\r\nConnection: close\r\n\r\n");
    stream.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let mut buf = String::new();
    stream.read_to_string(&mut buf).ok();
    Ok(buf.starts_with("HTTP/1.0 200")
        || buf.starts_with("HTTP/1.1 200")
        || buf.contains("\"status\":\"ok\""))
}

fn resolve_core_entry(repo_root: &Path) -> Result<PathBuf, String> {
    let candidates = [
        repo_root.join("src").join("index.js"),
        repo_root.join("dist").join("index.js"),
    ];
    for c in candidates {
        if c.exists() {
            return Ok(c);
        }
    }
    Err(format!(
        "找不到 Core 入口 (期望 {}/src/index.js)，且未捆绑 omniapi-core 二进制",
        repo_root.display()
    ))
}

pub type SharedCore = Arc<CoreManager>;
