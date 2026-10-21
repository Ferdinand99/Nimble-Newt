//! Tauri shell around `nimble-core`: commands, native menu, file associations,
//! single-instance forwarding and the updater.

mod menu;

use nimble_core::encoding::TextEncoding;
use nimble_core::eol::Eol;
use nimble_core::fileio::{self, OpenedFile, WriteResult};
use nimble_core::search::{self, ReplaceReport, SearchOptions, SearchReport};
use nimble_core::session::{RestoredSession, SessionMeta, SessionStore};
use nimble_core::update::{self, UpdateErrorKind};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::UpdaterExt;

static START: OnceLock<Instant> = OnceLock::new();

#[derive(Default)]
struct Pending {
    paths: Mutex<Vec<String>>,
    ready: AtomicBool,
}

#[derive(Default)]
struct PendingUpdate(Mutex<Option<tauri_plugin_updater::Update>>);

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ---- files ---------------------------------------------------------------

#[tauri::command]
async fn open_file(path: String, default_eol: Eol) -> CmdResult<OpenedFile> {
    fileio::read(Path::new(&path), default_eol).map_err(err)
}

#[tauri::command]
async fn open_file_as(
    path: String,
    encoding: TextEncoding,
    default_eol: Eol,
) -> CmdResult<OpenedFile> {
    fileio::read_as(Path::new(&path), encoding, default_eol).map_err(err)
}

#[tauri::command]
async fn save_file(
    path: String,
    text: String,
    encoding: TextEncoding,
    eol: Eol,
) -> CmdResult<WriteResult> {
    fileio::write(Path::new(&path), &text, encoding, eol).map_err(err)
}

/// Modification time per path in ms, `None` when the file is gone. Used for external-change detection.
#[tauri::command]
async fn file_mtimes(paths: Vec<String>) -> Vec<Option<i64>> {
    paths
        .iter()
        .map(|p| fileio::mtime_ms(Path::new(p)))
        .collect()
}

// ---- session and documents ----------------------------------------------

#[tauri::command]
async fn session_load(store: State<'_, SessionStore>) -> CmdResult<RestoredSession> {
    Ok(store.load())
}

#[tauri::command]
async fn session_save(store: State<'_, SessionStore>, meta: SessionMeta) -> CmdResult<()> {
    store.write_meta(&meta).map_err(err)
}

#[tauri::command]
async fn buffer_write(store: State<'_, SessionStore>, id: String, text: String) -> CmdResult<()> {
    store.write_buffer(&id, &text).map_err(err)
}

#[tauri::command]
async fn buffer_delete(store: State<'_, SessionStore>, id: String) -> CmdResult<()> {
    store.delete_buffer(&id).map_err(err)
}

#[tauri::command]
async fn doc_read(store: State<'_, SessionStore>, name: String) -> CmdResult<Option<String>> {
    store.read_doc(&name).map_err(err)
}

#[tauri::command]
async fn doc_write(store: State<'_, SessionStore>, name: String, json: String) -> CmdResult<()> {
    store.write_doc(&name, &json).map_err(err)
}

// ---- search --------------------------------------------------------------

#[tauri::command]
async fn search_folder(
    options: SearchOptions,
    replacement: Option<String>,
) -> CmdResult<SearchReport> {
    tauri::async_runtime::spawn_blocking(move || search::search(&options, replacement.as_deref()))
        .await
        .map_err(err)?
        .map_err(err)
}

#[tauri::command]
async fn replace_in_folder(
    options: SearchOptions,
    replacement: String,
    paths: Vec<String>,
) -> CmdResult<ReplaceReport> {
    tauri::async_runtime::spawn_blocking(move || {
        search::replace_in_files(&options, &replacement, &paths)
    })
    .await
    .map_err(err)?
    .map_err(err)
}

// ---- app lifecycle -------------------------------------------------------

/// Paths passed on the command line or by the OS before the frontend was ready.
#[tauri::command]
fn take_pending_paths(pending: State<'_, Pending>) -> Vec<String> {
    pending.ready.store(true, Ordering::SeqCst);
    std::mem::take(&mut *pending.paths.lock().unwrap())
}

#[tauri::command]
fn set_locale(app: AppHandle, locale: String) -> CmdResult<()> {
    let m = menu::build(&app, &locale).map_err(err)?;
    app.set_menu(m).map_err(err)?;
    Ok(())
}

/// Called by the frontend once the first tab is painted. Records cold-start time
/// (process `run()` to usable window); with `NIMBLE_STARTUP_REPORT=<file>` it writes the number and quits.
#[tauri::command]
fn app_ready(app: AppHandle) {
    let ms = START
        .get()
        .map(|s| s.elapsed().as_secs_f64() * 1000.0)
        .unwrap_or(0.0);
    eprintln!("nimble-newt: ready in {ms:.0} ms");
    if let Ok(path) = std::env::var("NIMBLE_STARTUP_REPORT") {
        let _ = std::fs::write(path, format!("{{\"startup_ms\":{ms:.1}}}"));
        app.exit(0);
    }
}

#[tauri::command]
fn restart_app(app: AppHandle) {
    app.restart();
}

// ---- updater -------------------------------------------------------------

#[derive(Serialize)]
struct UpdateInfo {
    version: String,
    notes: String,
    date: Option<String>,
}

#[derive(Serialize)]
struct UpdateFailure {
    kind: UpdateErrorKind,
    message: String,
}

fn failure(message: impl std::fmt::Display) -> UpdateFailure {
    let message = message.to_string();
    UpdateFailure {
        kind: update::classify_error(&message),
        message,
    }
}

fn updater_key_configured(app: &AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|v| v.get("pubkey"))
        .and_then(|v| v.as_str())
        .is_some_and(|k| !update::is_placeholder_key(k))
}

/// Asks GitHub for `latest.json`. `Ok(None)` means up to date. The plugin verifies the
/// signature of the download itself; nothing unsigned or wrongly signed is ever installed.
#[tauri::command]
async fn check_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<Option<UpdateInfo>, UpdateFailure> {
    if !updater_key_configured(&app) {
        return Err(UpdateFailure {
            kind: UpdateErrorKind::NotConfigured,
            message: "This build has no update signing key (see docs/updates.md).".into(),
        });
    }
    let found = app
        .updater()
        .map_err(failure)?
        .check()
        .await
        .map_err(failure)?;
    let Some(u) =
        found.filter(|u| update::is_newer(&u.current_version, &u.version).unwrap_or(false))
    else {
        *pending.0.lock().unwrap() = None;
        return Ok(None);
    };
    let info = UpdateInfo {
        version: u.version.clone(),
        notes: u.body.clone().unwrap_or_default(),
        date: u.date.map(|d| d.to_string()),
    };
    *pending.0.lock().unwrap() = Some(u);
    Ok(Some(info))
}

#[tauri::command]
async fn install_update(
    pending: State<'_, PendingUpdate>,
    on_event: Channel<serde_json::Value>,
) -> Result<(), UpdateFailure> {
    let update = pending
        .0
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| failure("no update has been checked"))?;
    let progress = on_event.clone();
    update
        .download_and_install(
            move |chunk, total| {
                let _ = progress.send(
                    serde_json::json!({ "event": "progress", "chunk": chunk, "total": total }),
                );
            },
            move || {
                let _ = on_event.send(serde_json::json!({ "event": "finished" }));
            },
        )
        .await
        .map_err(failure)
}

// ---- opening files from outside -------------------------------------------

fn existing_files<I: IntoIterator<Item = String>>(args: I, cwd: Option<&Path>) -> Vec<String> {
    args.into_iter()
        .filter(|a| !a.starts_with('-'))
        .map(|a| {
            let p = PathBuf::from(&a);
            if p.is_relative() {
                cwd.map(|c| c.join(&p)).unwrap_or(p)
            } else {
                p
            }
        })
        .filter(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

fn deliver_paths(app: &AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    let pending = app.state::<Pending>();
    if pending.ready.load(Ordering::SeqCst) {
        let _ = app.emit("open-paths", paths);
    } else {
        pending.paths.lock().unwrap().extend(paths);
    }
}

fn focus_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub fn run() {
    let _ = START.set(Instant::now());

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            deliver_paths(
                app,
                existing_files(args.into_iter().skip(1), Some(Path::new(&cwd))),
            );
            focus_main(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Pending::default())
        .manage(PendingUpdate::default())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            app.manage(SessionStore::new(dir).map_err(|e| e.to_string())?);
            let args = existing_files(
                std::env::args().skip(1),
                std::env::current_dir().ok().as_deref(),
            );
            app.state::<Pending>().paths.lock().unwrap().extend(args);
            app.set_menu(menu::build(app.handle(), "en")?)?;
            app.on_menu_event(|app, event| {
                let id = event.id().as_ref();
                if id == "file.quit" {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.close();
                    }
                } else {
                    let _ = app.emit("menu", id);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_file,
            open_file_as,
            save_file,
            file_mtimes,
            session_load,
            session_save,
            buffer_write,
            buffer_delete,
            doc_read,
            doc_write,
            search_folder,
            replace_in_folder,
            take_pending_paths,
            set_locale,
            app_ready,
            restart_app,
            check_update,
            install_update,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Nimble Newt");

    app.run(|_app, _event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = _event {
            let paths = urls
                .iter()
                .filter_map(|u| u.to_file_path().ok())
                .filter(|p| p.is_file())
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            deliver_paths(_app, paths);
            focus_main(_app);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_existing_files_are_accepted() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "x").unwrap();
        let out = existing_files(
            vec!["a.txt".into(), "missing.txt".into(), "--flag".into()],
            Some(dir.path()),
        );
        assert_eq!(out.len(), 1);
        assert!(out[0].ends_with("a.txt"));
    }
}
