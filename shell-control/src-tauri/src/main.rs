#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{self, BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::ManagerExt;

#[cfg(windows)]
mod windows;

const APP_ID: &str = "dev.probe.shellcontrol";

#[derive(Deserialize)]
struct Control {
    id: u32,
    action: String,
    value: Value,
    #[serde(default)]
    window: Option<String>,
    #[serde(default)]
    defer: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum ErrorCode {
    UnknownSetting,
    InvalidType,
    WindowUnavailable,
    AutostartIo,
}

#[derive(Serialize)]
struct Refusal {
    code: ErrorCode,
    message: String,
}

impl Refusal {
    fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Serialize)]
#[serde(untagged)]
enum Reply {
    Applied { id: u32, ok: bool, applied: bool },
    Refused { id: u32, ok: bool, error: Refusal },
}

fn set_autostart(app: &AppHandle, enabled: bool) -> Result<bool, Refusal> {
    let manager = app.autolaunch();
    let write = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    write
        .and_then(|()| manager.is_enabled())
        .map_err(|err| Refusal::new(ErrorCode::AutostartIo, err.to_string()))
}

fn apply(app: &AppHandle, keep_open: &AtomicBool, request: &Control) -> Result<bool, Refusal> {
    let enabled = || {
        request
            .value
            .as_bool()
            .ok_or_else(|| Refusal::new(ErrorCode::InvalidType, "Expected a boolean"))
    };
    match request.action.as_str() {
        "autostart" => set_autostart(app, enabled()?),
        "close-to-background" => {
            let enabled = enabled()?;
            let label = request.window.as_deref().unwrap_or("main");
            if app.get_webview_window(label).is_none() {
                return Err(Refusal::new(
                    ErrorCode::WindowUnavailable,
                    "Window does not exist",
                ));
            }
            keep_open.store(enabled, Ordering::SeqCst);
            Ok(keep_open.load(Ordering::SeqCst))
        }
        _ => Err(Refusal::new(
            ErrorCode::UnknownSetting,
            "Setting does not exist",
        )),
    }
}

fn result(
    stdin: &mut impl Write,
    request: &Control,
    applied: Result<bool, Refusal>,
) -> io::Result<()> {
    let id = request.id;
    let frame = match applied {
        Ok(applied) => Reply::Applied {
            id,
            ok: true,
            applied,
        },
        Err(error) => Reply::Refused {
            id,
            ok: false,
            error,
        },
    };
    writeln!(stdin, "result {}", serde_json::to_string(&frame)?)?;
    stdin.flush()
}

fn delay(phase: &str, id: u32) {
    println!("delay {phase} {id}");
    io::stdout().flush().expect("flush delay marker");
    std::thread::sleep(Duration::from_secs(20));
}

fn supervise(
    app: AppHandle,
    keep_open: Arc<AtomicBool>,
    mode: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let executable = std::env::current_exe()?.with_file_name(if cfg!(windows) {
        "probe-engine.exe"
    } else {
        "probe-engine"
    });
    let mut command = Command::new(executable);
    command.stdin(Stdio::piped()).stdout(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn()?;
    let mut stdin = child.stdin.take().expect("engine stdin");
    let stdout = child.stdout.take().expect("engine stdout");
    #[cfg(windows)]
    let _access = windows::current_user_access()?;
    let mut deferred = None;
    for line in BufReader::new(stdout).lines() {
        let line = line?;
        if let Some(json) = line.strip_prefix("control ") {
            let request: Control = serde_json::from_str(json)?;
            if request.defer {
                assert!(
                    deferred.replace(request).is_none(),
                    "only one deferred request"
                );
                continue;
            }
            if mode == "before" {
                delay("before", request.id);
            }
            let applied = apply(&app, &keep_open, &request);
            if mode == "after" && matches!(applied, Ok(true)) {
                delay("after", request.id);
            }
            result(&mut stdin, &request, applied)?;
            if let Some(earlier) = deferred.take() {
                result(&mut stdin, &earlier, apply(&app, &keep_open, &earlier))?;
            }
        } else if line == "fixture close" {
            app.get_webview_window("main")
                .expect("main window")
                .close()?;
        }
    }
    drop(stdin);
    let status = child.wait()?;
    app.exit(if status.success() { 0 } else { 1 });
    Ok(())
}

fn main() {
    let Some(dir) = std::env::var_os("PROBE_DIR") else {
        return;
    };
    let mode = std::env::var("PROBE_MODE").expect("PROBE_MODE");
    let keep_open = Arc::new(AtomicBool::new(false));
    let close_policy = keep_open.clone();
    tauri::Builder::default()
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name(APP_ID)
                .build(),
        )
        .on_window_event(move |_, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if close_policy.load(Ordering::SeqCst) {
                    api.prevent_close();
                    println!("close prevented");
                } else {
                    println!("close allowed");
                }
            }
        })
        .setup(move |app| {
            if mode == "cleanup" {
                #[cfg(windows)]
                let _access = windows::current_user_access()?;
                set_autostart(app.handle(), false).map_err(|err| io::Error::other(err.message))?;
                app.handle().exit(0);
                return Ok(());
            }
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .visible(false)
                .incognito(true)
                .data_directory(Path::new(&dir).join("webview"))
                .build()?;
            let app = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(err) = supervise(app.clone(), keep_open, &mode) {
                    eprintln!("supervisor error: {err}");
                    app.exit(1);
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("run probe shell");
}
