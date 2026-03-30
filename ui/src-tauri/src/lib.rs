use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

// ---------------------------------------------------------------------------
// Analytics — fire-and-forget launch ping to Google Sheets
// ---------------------------------------------------------------------------
const ANALYTICS_URL: &str = "https://script.google.com/macros/s/AKfycbxaULtARcNkE_g2UrYn6uL8vn_qCu82epOHSEjb8AnXJI0rrKO0Yty3_yN6BL20IrclfA/exec";
const APP_VERSION:   &str = "1.0.5";

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
// Service launcher
// ---------------------------------------------------------------------------

fn spawn_services(app: &AppHandle) -> Vec<Child> {
    let mut children: Vec<Child> = Vec::new();

    // ---- Resolve project root ----
    let project_root = resolve_project_root(app);

    // ---- Load .env ----
    // Prefer app config dir (e.g., %APPDATA%/com.wardog.sovereign/), fall back
    // to project root.
    let mut env_loaded = false;
    if let Ok(config_dir) = app.path().app_config_dir() {
        let env_path = config_dir.join(".env");
        if env_path.exists() {
            load_dotenv(&env_path);
            env_loaded = true;
        }
    }
    if !env_loaded {
        if let Some(root) = &project_root {
            let env_path = root.join(".env");
            if env_path.exists() {
                load_dotenv(&env_path);
            }
        }
    }

    // ---- 1. Redis ----
    let redis_exe = PathBuf::from(r"C:\Program Files\Redis\redis-server.exe");
    if redis_exe.exists() {
        match Command::new(&redis_exe).spawn() {
            Ok(child) => {
                eprintln!("[SOVEREIGN] Redis started (pid {})", child.id());
                children.push(child);
            }
            Err(e) => eprintln!("[SOVEREIGN] Failed to start Redis: {e}"),
        }
    } else {
        eprintln!("[SOVEREIGN] Redis not found at {}, assuming already running", redis_exe.display());
    }

    // ---- 2. sovereign-core ----
    if let Some(sovereign_exe) = find_sovereign_exe(app, project_root.as_deref()) {
        match Command::new(&sovereign_exe).spawn() {
            Ok(child) => {
                eprintln!("[SOVEREIGN] sovereign-core started (pid {})", child.id());
                children.push(child);
            }
            Err(e) => eprintln!("[SOVEREIGN] Failed to start sovereign-core: {e}"),
        }
    } else {
        eprintln!("[SOVEREIGN] sovereign-core.exe not found — WebSocket feed will be unavailable");
    }

    // For the Python services we need a project root; bail out early with a
    // warning rather than panicking if we genuinely can't find one.
    let root = match &project_root {
        Some(r) => r.clone(),
        None => {
            eprintln!("[SOVEREIGN] Could not locate project root — Python services will not start");
            return children;
        }
    };

    // ---- 3. signal/news_poller.py ----
    {
        let venv = root.join("signal").join(".venv");
        let python = venv_python(&venv);
        let script = root.join("signal").join("news_poller.py");
        if script.exists() {
            let py_bin = if python.exists() {
                python
            } else {
                PathBuf::from("python")
            };
            match Command::new(&py_bin)
                .arg(&script)
                .current_dir(&root)
                .spawn()
            {
                Ok(child) => {
                    eprintln!("[SOVEREIGN] news_poller.py started (pid {})", child.id());
                    children.push(child);
                }
                Err(e) => eprintln!("[SOVEREIGN] Failed to start news_poller.py: {e}"),
            }
        } else {
            eprintln!("[SOVEREIGN] news_poller.py not found at {}", script.display());
        }
    }

    // ---- 4. contracts/poller.py ----
    {
        let venv = root.join("contracts").join(".venv");
        let python = venv_python(&venv);
        let script = root.join("contracts").join("poller.py");
        if script.exists() {
            let py_bin = if python.exists() {
                python
            } else {
                PathBuf::from("python")
            };
            match Command::new(&py_bin)
                .arg(&script)
                .current_dir(&root)
                .spawn()
            {
                Ok(child) => {
                    eprintln!("[SOVEREIGN] contracts/poller.py started (pid {})", child.id());
                    children.push(child);
                }
                Err(e) => eprintln!("[SOVEREIGN] Failed to start contracts/poller.py: {e}"),
            }
        } else {
            eprintln!("[SOVEREIGN] contracts/poller.py not found at {}", script.display());
        }
    }

    // ---- 5. signal/engine.py ----
    {
        let venv = root.join("signal").join(".venv");
        let python = venv_python(&venv);
        let script = root.join("signal").join("engine.py");
        if script.exists() {
            let py_bin = if python.exists() {
                python
            } else {
                PathBuf::from("python")
            };
            match Command::new(&py_bin)
                .arg(&script)
                .current_dir(&root)
                .spawn()
            {
                Ok(child) => {
                    eprintln!("[SOVEREIGN] signal/engine.py started (pid {})", child.id());
                    children.push(child);
                }
                Err(e) => eprintln!("[SOVEREIGN] Failed to start signal/engine.py: {e}"),
            }
        } else {
            eprintln!("[SOVEREIGN] signal/engine.py not found at {}", script.display());
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
// Entry point
// ---------------------------------------------------------------------------
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Fire analytics ping (background thread — non-blocking).
            ping_analytics(app.handle());

            // Spawn all backend services immediately.
            let children = spawn_services(app.handle());
            app.manage(Arc::new(ServiceHandles(Mutex::new(children))));

            // Retrieve the main window so we can show it after a short delay.
            let window = app
                .get_webview_window("main")
                .expect("main window not found");

            // Spawn a thread that waits 3 seconds (letting services initialise)
            // and then makes the window visible.
            thread::spawn(move || {
                thread::sleep(Duration::from_secs(3));
                if let Err(e) = window.show() {
                    eprintln!("[SOVEREIGN] Failed to show window: {e}");
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                let handles = window
                    .app_handle()
                    .state::<Arc<ServiceHandles>>();
                kill_all(&handles);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running SOVEREIGN");
}
