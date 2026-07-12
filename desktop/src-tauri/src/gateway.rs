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

/// Kill any process listening on the given TCP port.
/// Used as a pre-start cleanup and as a fallback when the child handle is lost.
/// 只匹配 LISTENING 状态且本地地址正好是该端口的行——此前用
/// `findstr :{port}` 会把远端地址、前缀端口（:87871）甚至连着该端口的
/// 浏览器/WebView 进程一并强杀。
fn kill_port_process(port: u16) {
    use std::process::Command;
    #[cfg(windows)]
    {
        let output = Command::new("netstat")
            .args(["-ano", "-p", "TCP"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        let suffix = format!(":{port}");
        if let Ok(out) = output {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                let parts: Vec<&str> = line.split_whitespace().collect();
                // TCP  0.0.0.0:8787  0.0.0.0:0  LISTENING  1234
                if parts.len() < 5 || !parts[0].eq_ignore_ascii_case("tcp") {
                    continue;
                }
                if !parts[3].eq_ignore_ascii_case("listening") || !parts[1].ends_with(&suffix) {
                    continue;
                }
                if let Ok(pid) = parts[4].parse::<u32>() {
                    if pid == 0 || pid == std::process::id() {
                        continue;
                    }
                    println!("[gateway] Kill ghost PID {pid} on port {port}");
                    let _ = Command::new("taskkill")
                        .args(["/F", "/T", "/PID", &pid.to_string()])
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .creation_flags(CREATE_NO_WINDOW)
                        .status();
                }
            }
        }
    }
    #[cfg(not(windows))]
    {
        let output = Command::new("sh")
            .args(["-c", &format!("lsof -ti tcp:{} -sTCP:LISTEN", port)])
            .output();
        if let Ok(out) = output {
            let text = String::from_utf8_lossy(&out.stdout);
            for pid_str in text.split_whitespace() {
                if let Ok(pid) = pid_str.parse::<u32>() {
                    if pid == std::process::id() { continue; }
                    println!("[gateway] Kill ghost PID {pid} on port {port}");
                    let _ = Command::new("kill").args(["-KILL", &pid.to_string()]).status();
                }
            }
        }
    }
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
        // 如果仍持有旧 child（例如停止后立刻启动），先取出并在锁外清理，
        // 避免旧停止线程/旧 child 干扰新启动。
        let stale_child = {
            let mut g = self.inner.lock();
            let child = g.child.take();
            g.intentional_stop = false;
            g.state = CoreState::Starting;
            g.last_error = None;
            child
        };

        if let Some(mut child) = stale_child {
            match child.try_wait() {
                Ok(Some(_)) | Err(_) => {}
                Ok(None) => {
                    let pid = child.id();
                    println!("[gateway] Old child PID {pid} still alive before start, force-killing");
                    self.kill_process_force(pid);
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }

        // 强制清理端口上可能残留的旧进程，确保后续 spawn 的新进程是我们自己的 child。
        kill_port_process(cfg.port);

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

        let mut child = cmd.spawn().map_err(|e| {
            format!(
                "无法启动 Core ({} {}): {}",
                launch.program.display(),
                launch.args.join(" "),
                e
            )
        })?;

        // stderr 必须持续排水：管道写满（~64KB）后子进程的所有 console.warn/error
        // 都会阻塞，核心表现为"跑着跑着卡死"。顺带把内容落盘，方便排查启动失败。
        if let Some(mut stderr) = child.stderr.take() {
            let log_path = data_dir.join("logs").join("core-stderr.log");
            std::thread::spawn(move || {
                use std::io::{Read, Write};
                if let Some(parent) = log_path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let mut file = std::fs::File::create(&log_path).ok();
                const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;
                let mut written: u64 = 0;
                let mut buf = [0u8; 8192];
                loop {
                    match stderr.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if written < MAX_LOG_BYTES {
                                if let Some(f) = file.as_mut() {
                                    let take = (MAX_LOG_BYTES - written).min(n as u64) as usize;
                                    let _ = f.write_all(&buf[..take]);
                                    written += take as u64;
                                }
                            }
                        }
                    }
                }
            });
        }

        {
            let mut g = self.inner.lock();
            g.child = Some(child);
            g.state = CoreState::Starting;
            g.started_at = Some(Instant::now());
            g.restart_attempts = 0;
        }

        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            if healthz_sync(cfg).unwrap_or(false) {
                let mut g = self.inner.lock();
                g.state = CoreState::Running;
                g.last_error = None;
                return Ok(self.status_unlocked(cfg, &g));
            }
            std::thread::sleep(Duration::from_millis(250));
        }

        let mut g = self.inner.lock();
        g.state = CoreState::Crashed;
        g.last_error = Some("启动超时：/healthz 无响应".into());
        Ok(self.status_unlocked(cfg, &g))
    }

    pub fn stop(&self, cfg: &DesktopConfig) -> Result<CoreStatus, String> {
        let child_opt = {
            let mut g = self.inner.lock();
            // 已停止且无子进程：直接返回，保证退出路径上重复调用不再触发
            // 端口扫描 + 健康等待（那会让"退出"看起来卡住几秒）。
            if g.child.is_none() && matches!(g.state, CoreState::Stopped) {
                g.intentional_stop = true;
                return Ok(self.status_unlocked(cfg, &g));
            }
            g.intentional_stop = true;
            g.child.take()
        };

        let mut child_confirmed_dead = false;
        if let Some(mut child) = child_opt {
            let pid = child.id();
            // 无窗口控制台进程收不到 WM_CLOSE，graceful taskkill 通常直接失败；
            // 失败就立即强杀，成功才给最多 800ms 的自然退出窗口。
            let grace_deadline = if self.kill_process_graceful(pid) {
                Instant::now() + Duration::from_millis(800)
            } else {
                Instant::now()
            };
            loop {
                if child.try_wait().ok().flatten().is_some() {
                    child_confirmed_dead = true;
                    break;
                }
                if Instant::now() >= grace_deadline {
                    break;
                }
                std::thread::sleep(Duration::from_millis(60));
            }
            if !child_confirmed_dead {
                self.kill_process_force(pid);
                let _ = child.kill();
                let _ = child.wait();
                child_confirmed_dead = true;
            }
            println!("[gateway] Core stopped: PID {pid}");
        } else {
            // 兜底：child handle 丢失（例如 healthz 快捷路径导致），
            // 仍然尝试通过端口杀掉残留进程。
            println!("[gateway] No child handle, killing any process on port {}", cfg.port);
            kill_port_process(cfg.port);
        }

        // 子进程已确认退出时端口随之释放，无需等待 healthz 消失；
        // 只有孤儿进程路径才需要有界复查。
        let mut still_alive = false;
        if !child_confirmed_dead {
            let deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < deadline {
                if !healthz_sync(cfg).unwrap_or(false) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(150));
            }
            still_alive = healthz_sync(cfg).unwrap_or(false);
            if still_alive {
                println!("[gateway] healthz still alive after stop, killing port {}", cfg.port);
                kill_port_process(cfg.port);
            }
        }

        let mut g = self.inner.lock();
        // 仅在用户仍想停止时才覆写状态。如果 start 已经把 intentional_stop
        // 重置为 false（快速点击 停止→启动），则不要覆盖。
        if g.intentional_stop {
            g.state = CoreState::Stopped;
            g.last_error = if still_alive {
                Some("停止失败：/healthz 仍可访问".into())
            } else {
                None
            };
        }
        Ok(self.status_unlocked(cfg, &g))
    }

    /// Whether a managed child process is currently held.
    pub fn has_child(&self) -> bool {
        self.inner.lock().child.is_some()
    }

    #[cfg(windows)]
    fn kill_process_graceful(&self, pid: u32) -> bool {
        use std::process::Command;
        let status = Command::new("taskkill")
            .args(["/PID", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status();
        match status {
            Ok(s) if s.success() => {
                println!("[gateway] Graceful kill sent to PID {pid}");
                true
            }
            Ok(s) => {
                eprintln!("[gateway] Graceful kill PID {pid} returned {s}");
                false
            }
            Err(e) => {
                eprintln!("[gateway] Graceful kill PID {pid} failed: {e}");
                false
            }
        }
    }

    #[cfg(windows)]
    fn kill_process_force(&self, pid: u32) {
        use std::process::Command;
        let status = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status();
        match status {
            Ok(s) if s.success() => println!("[gateway] Force kill PID {pid} tree succeeded"),
            Ok(s) => eprintln!("[gateway] Force kill PID {pid} tree returned {s}"),
            Err(e) => eprintln!("[gateway] Force kill PID {pid} tree failed: {e}"),
        }
    }

    #[cfg(not(windows))]
    fn kill_process_graceful(&self, pid: u32) -> bool {
        use std::process::Command;
        Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    #[cfg(not(windows))]
    fn kill_process_force(&self, pid: u32) {
        use std::process::Command;
        let _ = Command::new("kill").args(["-KILL", &pid.to_string()]).status();
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
            if g.intentional_stop {
                // 用户主动点了停止——不要因为旧进程 healthz 还活着就复活 state
                // 等后台线程杀完进程后 tick 自然会看到 child 退出 + intentional_stop
            } else if healthy {
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
