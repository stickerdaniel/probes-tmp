#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    env, fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::Instant,
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;

#[derive(Deserialize)]
struct Session {
    variant: String,
    output: PathBuf,
    stop: PathBuf,
}

struct Probe {
    session: Session,
    started: Instant,
    pending: Mutex<Vec<String>>,
}

fn append(output: &Path, row: &Value) -> io::Result<()> {
    let pid = std::process::id();
    let mut row = row.clone();
    row["pid"] = json!(pid);
    let mut encoded = serde_json::to_vec(&row)?;
    encoded.push(b'\n');
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(output)?
        .write_all(&encoded)
}

fn receive(app: &AppHandle, urls: impl IntoIterator<Item = String>) {
    let probe = app.state::<Probe>();
    probe.pending.lock().unwrap().extend(urls);
    let _ = app.emit("routeprobe-link", ());
}

#[tauri::command]
fn settings(probe: State<'_, Probe>) -> Value {
    json!({ "variant": probe.session.variant, "mac": cfg!(target_os = "macos") })
}

#[tauri::command]
fn take_links(probe: State<'_, Probe>) -> Vec<String> {
    std::mem::take(&mut *probe.pending.lock().unwrap())
}

#[tauri::command]
fn show_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.show().map_err(|error| error.to_string())
}

#[tauri::command]
fn record(app: AppHandle, probe: State<'_, Probe>, mut row: Value) -> Result<(), String> {
    row["elapsedMs"] = json!(probe.started.elapsed().as_secs_f64() * 1000.0);
    row["windows"] = json!(app.webview_windows().len());
    row["visible"] = json!(app
        .get_webview_window("main")
        .and_then(|window| window.is_visible().ok()));
    append(&probe.session.output, &row).map_err(|error| error.to_string())
}

fn main() {
    let started = Instant::now();
    let marker = env::var_os("ROUTEPROBE_SESSION")
        .map(PathBuf::from)
        .unwrap_or_else(|| env::temp_dir().join("routeprobe-session.json"));
    let Ok(config) = fs::read(marker) else {
        return;
    };
    let session: Session = serde_json::from_slice(&config).expect("read session");
    append(&session.output, &json!({ "kind": "process" })).expect("record process");
    let output = session.output.clone();

    let result = tauri::Builder::default()
        .manage(Probe { session, started, pending: Mutex::new(Vec::new()) })
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {
            #[cfg(target_os = "macos")]
            receive(_app, _args.into_iter().skip(1).filter(|arg| arg.starts_with("routeprobe://")));
        }))
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![settings, take_links, show_window, record])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                receive(&handle, event.urls().into_iter().map(|url| url.to_string()));
            });
            if let Some(urls) = app.deep_link().get_current()? {
                receive(app.handle(), urls.into_iter().map(|url| url.to_string()));
            }

            let probe = app.state::<Probe>();
            let output = probe.session.output.clone();
            let stop = probe.session.stop.clone();
            let missing_entry = probe.session.variant == "entry-404";
            let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Route probe")
                .inner_size(680.0, 460.0)
                .visible(false)
                .focused(false)
                .incognito(true)
                .initialization_script(include_str!("observe.js"))
                .on_web_resource_request(move |request, response| {
                    let path = request.uri().path();
                    if missing_entry && matches!(path, "/" | "/index.html") {
                        *response.status_mut() = tauri::http::StatusCode::NOT_FOUND;
                        *response.body_mut() = std::borrow::Cow::Borrowed(b"");
                        let _ = append(&output, &json!({
                            "kind": "row", "case": "cold", "status": "fail", "blank": true,
                            "reason": "Entry document returned 404"
                        }));
                    }
                    let status = response.status().as_u16();
                    let wrong_body = [".js", ".css", ".json"].iter().any(|extension| path.ends_with(extension))
                        && response.body().iter().find(|byte| !byte.is_ascii_whitespace()) == Some(&b'<');
                    let _ = append(&output, &json!({
                        "kind": "asset", "path": path, "status": status, "failed": status >= 400 || wrong_body
                    }));
                });

            if let Ok(position) = env::var("ROUTEPROBE_POSITION") {
                let (x, y) = position.split_once(',').ok_or("invalid probe position")?;
                builder = builder.position(x.parse()?, y.parse()?);
            }
            builder.build()?;

            let handle = app.handle().clone();
            std::thread::spawn(move || {
                while !stop.exists() {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                handle.exit(0);
            });
            Ok(())
        })
        .run(tauri::generate_context!());

    if let Err(error) = result {
        let _ = append(
            &output,
            &json!({ "kind": "shell-error", "message": error.to_string() }),
        );
    }
}
