use std::{
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use tauri::{RunEvent, WebviewUrl, WebviewWindowBuilder};

const APP_LABEL: &str = "main";
const WINDOW_TITLE: &str = "Schema Studio Light";
const BACKEND_HOST: &str = "127.0.0.1";
const BACKEND_PORT: u16 = 5179;
const BACKEND_URL: &str = "http://127.0.0.1:5179";
const HEALTH_URL: &str = "http://127.0.0.1:5179/health";

type SharedChild = Arc<Mutex<Option<Child>>>;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("src-tauri should live under web/")
        .to_path_buf()
}

fn preferred_python(repo_root: &Path) -> String {
    let candidate = repo_root.join(".venv").join("Scripts").join("python.exe");
    if candidate.exists() {
        return candidate.to_string_lossy().into_owned();
    }
    "python".to_string()
}

fn spawn_backend() -> Result<Child, String> {
    let repo_root = repo_root();
    let mut cmd = Command::new(preferred_python(&repo_root));
    cmd.current_dir(&repo_root)
        .arg("-m")
        .arg("api.light_mode.cli")
        .env("SCHEMA_STUDIO_HOST", BACKEND_HOST)
        .env("SCHEMA_STUDIO_PORT", BACKEND_PORT.to_string())
        .env("SCHEMA_STUDIO_OPEN_BROWSER", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn()
        .map_err(|err| format!("failed to launch Light Mode backend: {err}"))
}

fn wait_for_backend(timeout: Duration) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(1))
        .build()
        .map_err(|err| format!("failed to build health-check client: {err}"))?;
    let start = Instant::now();
    while start.elapsed() < timeout {
        match client.get(HEALTH_URL).send() {
            Ok(response) if response.status().is_success() => return Ok(()),
            _ => thread::sleep(Duration::from_millis(250)),
        }
    }
    Err(format!(
        "Light Mode backend did not become ready at {HEALTH_URL} within {} seconds",
        timeout.as_secs()
    ))
}

fn stop_backend(child_state: &SharedChild) {
    let mut guard = child_state.lock().expect("backend child mutex poisoned");
    if let Some(mut child) = guard.take() {
        #[cfg(target_os = "windows")]
        {
            let _ = Command::new("taskkill")
                .args(["/PID", &child.id().to_string(), "/T", "/F"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }

        let _ = child.kill();
        let _ = child.wait();
    }
}

fn main() {
    let backend_child: SharedChild = Arc::new(Mutex::new(None));
    let managed_child = Arc::clone(&backend_child);

    tauri::Builder::default()
        .setup(move |app| {
            let child = spawn_backend()?;
            {
                let mut guard = managed_child.lock().expect("backend child mutex poisoned");
                *guard = Some(child);
            }

            if let Err(err) = wait_for_backend(Duration::from_secs(30)) {
                stop_backend(&managed_child);
                return Err(err.into());
            }

            WebviewWindowBuilder::new(
                app,
                APP_LABEL,
                WebviewUrl::External(BACKEND_URL.parse().expect("valid backend URL")),
            )
            .title(WINDOW_TITLE)
            .inner_size(1440.0, 960.0)
            .min_inner_size(1100.0, 720.0)
            .resizable(true)
            .build()?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Schema Studio desktop shell")
        .run(move |_app_handle, event| {
            if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
                stop_backend(&backend_child);
            }
        });
}
