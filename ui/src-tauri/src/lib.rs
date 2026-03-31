use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

// Windows: spawn child processes without any visible console window.
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

// ---------------------------------------------------------------------------
// Analytics — fire-and-forget launch ping to Google Sheets
// ---------------------------------------------------------------------------
const ANALYTICS_URL: &str = "https://script.google.com/macros/s/AKfycbxaULtARcNkE_g2UrYn6uL8vn_qCu82epOHSEjb8AnXJI0rrKO0Yty3_yN6BL20IrclfA/exec";
const APP_VERSION:   &str = "1.2.1";

/// Read or create a persistent session UUID stored in the app's config dir.
fn session_id(app: &AppHandle) -> String {
    let id_file = app.path().app_config_dir()
        .ok()
        .map(|d| d.join("session_id"));

    if let Some(ref path) = id_file {
        if let Ok(id) = std::fs::read_to_string(path) {
            let id = id.trim().to_string();
            if !id.is_empty() { return id; }
        }
    }

    // Generate a new UUID v4 (no external crate — use random bytes).
    let mut b = [0u8; 16];
    for (i, byte) in b.iter_mut().enumerate() {
        // Simple PRNG seeded from time + index — good enough for a session ID.
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .subsec_nanos();
        *byte = ((t ^ (i as u32 * 2654435761)) & 0xff) as u8;
        std::thread::sleep(std::time::Duration::from_nanos(1));
    }
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant
    let id = format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        b[0],b[1],b[2],b[3],b[4],b[5],b[6],b[7],b[8],b[9],b[10],b[11],b[12],b[13],b[14],b[15]
    );

    if let Some(path) = id_file {
        let _ = std::fs::create_dir_all(path.parent().unwrap_or(&path));
        let _ = std::fs::write(&path, &id);
    }
    id
}

/// Ping the analytics endpoint in a background thread — never blocks the UI.
fn ping_analytics(app: &AppHandle) {
    let sid = session_id(app);
    let os  = std::env::consts::OS.to_string();
    let url = format!(
        "{ANALYTICS_URL}?sid={sid}&v={APP_VERSION}&os={os}"
    );
    thread::spawn(move || {
        // Use Windows' built-in curl (available on Win10+) — no extra dep.
        let _ = Command::new("curl")
            .args(["-s", "-m", "5", "-L", &url])
            .output();
    });
}

// ---------------------------------------------------------------------------
// State: holds all spawned child process handles so we can kill them on exit.
// ---------------------------------------------------------------------------
struct ServiceHandles(Mutex<Vec<Child>>);

// ---------------------------------------------------------------------------
// Path resolution helpers
// ---------------------------------------------------------------------------

/// Walk up from `start` looking for a directory that contains the sentinel
/// file `marker` (e.g. "sovereign" sub-directory or "signal" sub-directory).
/// Returns the first ancestor that contains it, or None.
fn find_project_root(start: &Path) -> Option<PathBuf> {
    let mut current = start.to_path_buf();
    loop {
        // A project root will have both `signal/` and `sovereign/` as children.
        if current.join("signal").is_dir() && current.join("sovereign").is_dir() {
            return Some(current);
        }
        if !current.pop() {
            return None;
        }
    }
}

/// Locate the project root whether we are running from:
///   - `target/debug/` or `target/release/` in dev mode, or
///   - the installed Tauri bundle (exe lives in resources bundle).
fn resolve_project_root(app: &AppHandle) -> Option<PathBuf> {
    // 1. Try walking up from the current executable.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(root) = find_project_root(exe.parent().unwrap_or(&exe)) {
            return Some(root);
        }
    }

    // 2. Try walking up from the current working directory (useful during dev
    //    when cargo run is executed from the workspace root).
    if let Ok(cwd) = std::env::current_dir() {
        if let Some(root) = find_project_root(&cwd) {
            return Some(root);
        }
    }

    // 3. In a bundled release the resources are placed next to the binary.
    //    Tauri exposes the resource path through the app handle.
    if let Ok(res_dir) = app.path().resource_dir() {
        if let Some(root) = find_project_root(&res_dir) {
            return Some(root);
        }
        // Resources dir itself might *be* the bundled project root in some
        // bundle layouts — return it as a fallback if it has binaries we need.
        if res_dir.join("sovereign-core.exe").exists()
            || res_dir.join("signal").is_dir()
        {
            return Some(res_dir);
        }
    }

    None
}

/// Find `sovereign-core.exe`.
///
/// Search order:
///   1. Next to the running executable (production bundle copy via sidecar).
///   2. Tauri resources dir.
///   3. `<project_root>/sovereign/target/release/sovereign-core.exe` (dev).
fn find_sovereign_exe(app: &AppHandle, project_root: Option<&Path>) -> Option<PathBuf> {
    // 1. Next to our own exe (sidecar / bundled copy).
    if let Ok(exe) = std::env::current_exe() {
        let candidate = exe.parent()?.join("sovereign-core.exe");
        if candidate.exists() {
            return Some(candidate);
        }
        // Tauri sidecar naming convention: <name>-<target-triple>.exe
        // Allow a wildcard glob approach: just check any file matching the prefix.
        if let Some(parent) = exe.parent() {
            if let Ok(entries) = std::fs::read_dir(parent) {
                for entry in entries.flatten() {
                    let name = entry.file_name();
                    let n = name.to_string_lossy();
                    if n.starts_with("sovereign-core") && n.ends_with(".exe") {
                        return Some(entry.path());
                    }
                }
            }
        }
    }

    // 2. Tauri resources dir.
    if let Ok(res_dir) = app.path().resource_dir() {
        let candidate = res_dir.join("sovereign-core.exe");
        if candidate.exists() {
            return Some(candidate);
        }
    }

    // 3. Dev build path.
    if let Some(root) = project_root {
        let dev = root
            .join("sovereign")
            .join("target")
            .join("release")
            .join("sovereign-core.exe");
        if dev.exists() {
            return Some(dev);
        }
    }

    None
}

/// Build a Command with CREATE_NO_WINDOW on Windows so no console ever pops up.
#[cfg(target_os = "windows")]
fn silent_cmd(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = Command::new(program);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}
#[cfg(not(target_os = "windows"))]
fn silent_cmd(program: impl AsRef<std::ffi::OsStr>) -> Command {
    Command::new(program)
}

/// Locate the Python interpreter for a given venv directory.
/// Returns `<venv>/Scripts/python.exe` on Windows, `<venv>/bin/python` elsewhere.
fn venv_python(venv: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        venv.join("Scripts").join("python.exe")
    }
    #[cfg(not(target_os = "windows"))]
    {
        venv.join("bin").join("python")
    }
}

// ---------------------------------------------------------------------------
// .env loading — sets environment variables from a KEY=VALUE file.
// ---------------------------------------------------------------------------
fn load_dotenv(path: &Path) {
    if let Ok(contents) = std::fs::read_to_string(path) {
        for line in contents.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((key, value)) = line.split_once('=') {
                let key = key.trim();
                let value = value.trim().trim_matches('"').trim_matches('\'');
                std::env::set_var(key, value);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Resource & runtime helpers
// ---------------------------------------------------------------------------

/// Find the root directory where bundled resources (signal/, contracts/, redis/)
/// live. Checks Tauri resource_dir first (installed app), then walks up from
/// the exe / cwd (dev mode).
fn find_resource_root(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(res_dir) = app.path().resource_dir() {
        // Array-form resources preserve path under resource_dir directly
        if res_dir.join("signal").is_dir() { return Some(res_dir.clone()); }
        // Some Tauri layouts nest under "resources/"
        let sub = res_dir.join("resources");
        if sub.join("signal").is_dir() { return Some(sub); }
    }
    None
}

/// Find a Python script, preferring bundled resources over dev project root.
fn find_script(resource_root: Option<&Path>, project_root: Option<&Path>, subdir: &str, name: &str) -> Option<PathBuf> {
    if let Some(r) = resource_root {
        let p = r.join(subdir).join(name);
        if p.exists() { return Some(p); }
    }
    if let Some(r) = project_root {
        let p = r.join(subdir).join(name);
        if p.exists() { return Some(p); }
    }
    None
}

/// Locate redis-server.exe: bundled → user portable → system install.
fn find_redis_exe(app: &AppHandle) -> Option<PathBuf> {
    // 1. Bundled inside the installer resources
    if let Some(res) = find_resource_root(app) {
        let c = res.join("redis").join("redis-server.exe");
        if c.exists() { return Some(c); }
        // Handle zip-extracted subdirectory (e.g. Redis-x64-5.0.14.1/)
        if let Ok(entries) = std::fs::read_dir(res.join("redis")) {
            for e in entries.flatten() {
                if e.file_name().to_string_lossy() == "redis-server.exe" {
                    return Some(e.path());
                }
                if e.path().is_dir() {
                    let nested = e.path().join("redis-server.exe");
                    if nested.exists() { return Some(nested); }
                }
            }
        }
    }
    // 2. User's portable Redis in Downloads/Redis5
    if let Ok(home) = std::env::var("USERPROFILE") {
        let p = PathBuf::from(&home).join("Downloads").join("Redis5").join("redis-server.exe");
        if p.exists() { return Some(p); }
    }
    // 3. System installation
    let sys = PathBuf::from(r"C:\Program Files\Redis\redis-server.exe");
    if sys.exists() { return Some(sys); }
    None
}

/// Return the venv Python executable stored in the app config dir.
fn app_venv_python(app: &AppHandle) -> Option<PathBuf> {
    let venv = app.path().app_config_dir().ok()?.join("venv");
    let py = venv_python(&venv);
    if py.exists() { Some(py) } else { None }
}

/// Best Python binary available: app venv → project venv → system.
fn best_python(app: &AppHandle, script_dir: Option<&Path>) -> PathBuf {
    if let Some(py) = app_venv_python(app) { return py; }
    if let Some(dir) = script_dir {
        let venv_py = venv_python(&dir.join(".venv"));
        if venv_py.exists() { return venv_py; }
    }
    PathBuf::from("python")
}

// ---------------------------------------------------------------------------
// Service launcher
// ---------------------------------------------------------------------------

fn spawn_services(app: &AppHandle) -> Vec<Child> {
    let mut children: Vec<Child> = Vec::new();

    let project_root   = resolve_project_root(app);
    let resource_root  = find_resource_root(app);

    // ---- Load .env ----
    let mut env_loaded = false;
    if let Ok(config_dir) = app.path().app_config_dir() {
        let env_path = config_dir.join(".env");
        if env_path.exists() { load_dotenv(&env_path); env_loaded = true; }
    }
    if !env_loaded {
        if let Some(root) = &project_root {
            let env_path = root.join(".env");
            if env_path.exists() { load_dotenv(&env_path); }
        }
    }

    // ---- 1. Redis ----
    // Only start Redis if it's not already listening on 6380.
    let redis_already_up = std::net::TcpStream::connect("127.0.0.1:6380").is_ok()
        || std::net::TcpStream::connect("127.0.0.1:6379").is_ok();

    if redis_already_up {
        eprintln!("[SOVEREIGN] Redis already running — skipping launch");
    } else if let Some(redis_exe) = find_redis_exe(app) {
        match silent_cmd(&redis_exe).args(["--port", "6380"]).spawn() {
            Ok(child) => {
                eprintln!("[SOVEREIGN] Redis started from {} (pid {})", redis_exe.display(), child.id());
                children.push(child);
                // Give Redis a moment to bind before Python services try to connect.
                thread::sleep(Duration::from_millis(800));
            }
            Err(e) => eprintln!("[SOVEREIGN] Failed to start Redis: {e}"),
        }
    } else {
        eprintln!("[SOVEREIGN] redis-server.exe not found — install Redis 5 or run start_sovereign.bat");
    }

    // ---- 2. sovereign-core ----
    if let Some(sovereign_exe) = find_sovereign_exe(app, project_root.as_deref()) {
        match silent_cmd(&sovereign_exe).spawn() {
            Ok(child) => {
                eprintln!("[SOVEREIGN] sovereign-core started (pid {})", child.id());
                children.push(child);
            }
            Err(e) => eprintln!("[SOVEREIGN] Failed to start sovereign-core: {e}"),
        }
    } else {
        eprintln!("[SOVEREIGN] sovereign-core.exe not found — WebSocket feed will be unavailable");
    }

    // ---- Python services ----
    // Resolve the Python binary to use (app venv → project venv → system).
    let signal_dir = resource_root.as_deref()
        .map(|r| r.join("signal"))
        .or_else(|| project_root.as_ref().map(|r| r.join("signal")));
    let python = best_python(app, signal_dir.as_deref());

    let res = resource_root.as_deref();
    let proj = project_root.as_deref();

    for (subdir, script_name, label) in &[
        ("signal",    "news_poller.py", "news_poller"),
        ("signal",    "rss_poller.py",  "rss_poller"),
        ("contracts", "poller.py",      "contracts/poller"),
        ("signal",    "engine.py",      "engine"),
    ] {
        match find_script(res, proj, subdir, script_name) {
            Some(script) => {
                // Set the script's directory as cwd so relative imports work.
                let cwd = script.parent().unwrap_or(&script).to_path_buf();
                match silent_cmd(&python).arg(&script).current_dir(&cwd).spawn() {
                    Ok(child) => {
                        eprintln!("[SOVEREIGN] {label} started (pid {})", child.id());
                        children.push(child);
                    }
                    Err(e) => eprintln!("[SOVEREIGN] Failed to start {label}: {e}"),
                }
            }
            None => eprintln!("[SOVEREIGN] {script_name} not found — skipping"),
        }
    }

    children
}

// ---------------------------------------------------------------------------
// Graceful shutdown: kill every child we own.
// ---------------------------------------------------------------------------
fn kill_all(handles: &Arc<ServiceHandles>) {
    let mut guard = handles.0.lock().unwrap();
    for child in guard.iter_mut() {
        eprintln!("[SOVEREIGN] Killing service pid {}", child.id());
        let _ = child.kill();
    }
    guard.clear();
}

// ---------------------------------------------------------------------------
// Setup commands — invoked from the React onboarding page
// ---------------------------------------------------------------------------

/// Check whether Python 3.11+ is available on PATH.
#[tauri::command]
fn check_python() -> serde_json::Value {
    for bin in &["python", "python3", "python3.11"] {
        if let Ok(out) = std::process::Command::new(bin).arg("--version").output() {
            let v = String::from_utf8_lossy(&out.stdout).to_string()
                + &String::from_utf8_lossy(&out.stderr).to_string();
            let v = v.trim().to_string();
            if v.starts_with("Python 3.") {
                return serde_json::json!({ "ok": true, "version": v });
            }
        }
    }
    serde_json::json!({ "ok": false, "version": "" })
}

/// Check whether Redis is reachable (port 6380 then 6379).
#[tauri::command]
fn check_redis() -> serde_json::Value {
    use std::net::TcpStream;
    if TcpStream::connect("127.0.0.1:6380").is_ok() {
        return serde_json::json!({ "ok": true, "port": 6380 });
    }
    if TcpStream::connect("127.0.0.1:6379").is_ok() {
        return serde_json::json!({ "ok": true, "port": 6379 });
    }
    serde_json::json!({ "ok": false, "port": 0 })
}

/// Run `pip install` into a persistent venv stored in the app config dir.
/// Creates the venv first if it doesn't exist.
/// This can take several minutes on a fresh machine (torch/transformers are large).
#[tauri::command]
fn install_python_deps(app: AppHandle) -> Result<String, String> {
    // 1. Find requirements.txt — bundled resources first, then dev project root.
    let req = find_resource_root(&app)
        .map(|r| r.join("signal").join("requirements.txt"))
        .filter(|p| p.exists())
        .or_else(|| {
            resolve_project_root(&app)
                .map(|r| r.join("signal").join("requirements.txt"))
                .filter(|p| p.exists())
        })
        .ok_or_else(|| "requirements.txt not found — is SOVEREIGN installed correctly?".to_string())?;

    // 2. Create venv in %APPDATA%/com.wardog.sovereign/venv/
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
    let venv = config_dir.join("venv");

    let venv_out = silent_cmd("python")
        .args(["-m", "venv", venv.to_str().unwrap_or("")])
        .output()
        .map_err(|e| format!("Failed to create Python venv: {e}"))?;
    if !venv_out.status.success() {
        return Err(String::from_utf8_lossy(&venv_out.stderr).to_string());
    }

    // 3. pip install using the venv's own pip
    let pip = venv.join("Scripts").join("pip.exe");
    let out = silent_cmd(&pip)
        .args(["install", "-r", req.to_str().unwrap_or(""), "--no-warn-script-location"])
        .output()
        .map_err(|e| format!("pip failed: {e}"))?;

    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}

/// Returns true if the user has already completed first-run key setup.
#[tauri::command]
fn is_setup_complete(app: AppHandle) -> bool {
    if let Ok(config_dir) = app.path().app_config_dir() {
        let env_path = config_dir.join(".env");
        if let Ok(contents) = std::fs::read_to_string(&env_path) {
            let has_finnhub = contents.lines().any(|l| {
                l.starts_with("FINNHUB_API_KEY=") && l.len() > "FINNHUB_API_KEY=".len()
            });
            let has_alpaca = contents.lines().any(|l| {
                l.starts_with("ALPACA_API_KEY=") && l.len() > "ALPACA_API_KEY=".len()
            });
            return has_finnhub && has_alpaca;
        }
    }
    false
}

/// Write the user's API keys to the app config dir, then start all services.
/// This is the single call the onboarding page makes when the user hits Launch.
#[tauri::command]
fn activate(
    app: AppHandle,
    handles: tauri::State<Arc<ServiceHandles>>,
    finnhub_key: String,
    alpaca_key: String,
    alpaca_secret: String,
) -> Result<(), String> {
    // 1. Persist keys to %APPDATA%/com.wardog.sovereign/.env
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
    let content = format!(
        "FINNHUB_API_KEY={}\nALPACA_API_KEY={}\nALPACA_SECRET_KEY={}\nREDIS_URL=redis://localhost:6380\n",
        finnhub_key.trim(),
        alpaca_key.trim(),
        alpaca_secret.trim(),
    );
    std::fs::write(config_dir.join(".env"), &content).map_err(|e| e.to_string())?;

    // 2. Load the keys into the current process environment so spawn_services
    //    picks them up without needing a restart.
    load_dotenv(&config_dir.join(".env"));

    // 3. Spawn all backend services.
    let new_children = spawn_services(&app);
    handles.0.lock().unwrap().extend(new_children);

    Ok(())
}

// ---------------------------------------------------------------------------
// Update check — fetches latest GitHub release and compares to APP_VERSION.
// Returns JSON { current, latest, has_update, url }.
// Run synchronously (called from user action); blocks for at most 5 s.
// ---------------------------------------------------------------------------
#[tauri::command]
fn check_update() -> serde_json::Value {
    let out = Command::new("curl")
        .args([
            "-s", "-m", "5", "-L",
            "https://api.github.com/repos/ravisahebstavan/sovereign-war-dogs/releases/latest",
            "-H", "User-Agent: sovereign-war-dogs",
        ])
        .output();

    let fallback = serde_json::json!({
        "current": APP_VERSION, "latest": APP_VERSION, "has_update": false, "url": ""
    });

    match out {
        Ok(o) if o.status.success() => {
            if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&o.stdout) {
                let latest  = json["tag_name"].as_str().unwrap_or("").trim_start_matches('v').to_string();
                let url     = json["html_url"].as_str().unwrap_or("").to_string();
                let has_upd = !latest.is_empty() && latest != APP_VERSION;
                serde_json::json!({
                    "current":    APP_VERSION,
                    "latest":     latest,
                    "has_update": has_upd,
                    "url":        url,
                })
            } else { fallback }
        }
        _ => fallback,
    }
}

// ---------------------------------------------------------------------------
// Open URL in the system's default browser.
// ---------------------------------------------------------------------------
#[tauri::command]
fn open_url(url: String) {
    #[cfg(target_os = "windows")]
    let _ = Command::new("cmd").args(["/c", "start", "", &url]).spawn();
    #[cfg(not(target_os = "windows"))]
    let _ = Command::new("xdg-open").arg(&url).spawn();
}

// ---------------------------------------------------------------------------
// Service status — quick TCP probe of Redis + sovereign-core ports.
// Returns JSON { redis: bool, sovereign: bool }.
// ---------------------------------------------------------------------------
#[tauri::command]
fn service_status() -> serde_json::Value {
    use std::net::TcpStream;
    let redis     = TcpStream::connect("127.0.0.1:6380").is_ok()
                    || TcpStream::connect("127.0.0.1:6379").is_ok();
    let sovereign = TcpStream::connect("127.0.0.1:9001").is_ok();
    serde_json::json!({ "redis": redis, "sovereign": sovereign })
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            ping_analytics(app.handle());

            // Register service handle store (may be empty until activate() is called).
            app.manage(Arc::new(ServiceHandles(Mutex::new(Vec::new()))));

            let window = app
                .get_webview_window("main")
                .expect("main window not found");

            if is_setup_complete(app.handle().clone()) {
                // Returning user — spawn services then reveal window after init.
                let children = spawn_services(app.handle());
                app.state::<Arc<ServiceHandles>>().0.lock().unwrap().extend(children);
                thread::spawn(move || {
                    thread::sleep(Duration::from_secs(3));
                    let _ = window.show();
                });
            } else {
                // First run — show onboarding page immediately, no services yet.
                let _ = window.show();
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            is_setup_complete,
            activate,
            check_python,
            check_redis,
            install_python_deps,
            check_update,
            open_url,
            service_status,
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                let handles = window.app_handle().state::<Arc<ServiceHandles>>();
                kill_all(&handles);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running SOVEREIGN");
}
