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
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::UpdaterExt;

static START: OnceLock<Instant> = OnceLock::new();

/// Paths handed to us before the frontend is listening. `ready` and the queue share one lock,
/// so a path can never slip in between "is the frontend ready?" and "take the queue".
#[derive(Default)]
struct Pending(Mutex<PendingInner>);

#[derive(Default)]
struct PendingInner {
    ready: bool,
    paths: Vec<String>,
}

impl Pending {
    /// Returns the paths to emit now when the frontend is ready, otherwise queues them.
    fn deliver(&self, paths: Vec<String>) -> Option<Vec<String>> {
        let mut inner = self.0.lock().unwrap();
        if inner.ready {
            Some(paths)
        } else {
            inner.paths.extend(paths);
            None
        }
    }

    /// Marks the frontend ready and returns everything queued so far.
    fn take(&self) -> Vec<String> {
        let mut inner = self.0.lock().unwrap();
        inner.ready = true;
        std::mem::take(&mut inner.paths)
    }
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

#[derive(Serialize)]
struct SaveFailure {
    /// `conflict`: the file changed on disk after it was opened; anything else is `other`.
    kind: &'static str,
    message: String,
}

/// `expected_mtime_ms` is the modification time the editor last saw; a different time on disk
/// is refused as a conflict. Pass `None` for new files, "Save As" and a confirmed overwrite.
#[tauri::command]
async fn save_file(
    path: String,
    text: String,
    encoding: TextEncoding,
    eol: Eol,
    expected_mtime_ms: Option<i64>,
) -> Result<WriteResult, SaveFailure> {
    fileio::write_checked(Path::new(&path), &text, encoding, eol, expected_mtime_ms).map_err(|e| {
        SaveFailure {
            kind: if matches!(e, nimble_core::Error::Conflict(_)) {
                "conflict"
            } else {
                "other"
            },
            message: e.to_string(),
        }
    })
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

#[derive(Serialize)]
struct EncodingInfo {
    label: &'static str,
    group: &'static str,
}

/// Every encoding the editor can read and write, for the pickers.
#[tauri::command]
fn list_encodings() -> Vec<EncodingInfo> {
    nimble_core::encoding::all()
        .into_iter()
        .map(|e| EncodingInfo {
            label: e.label(),
            group: e.group(),
        })
        .collect()
}

// ---- folder workspace ------------------------------------------------------------

#[tauri::command]
async fn list_dir(
    path: String,
    show_hidden: bool,
    respect_gitignore: bool,
) -> CmdResult<Vec<nimble_core::folder::Entry>> {
    tauri::async_runtime::spawn_blocking(move || {
        nimble_core::folder::list_dir(
            Path::new(&path),
            nimble_core::folder::ListOptions {
                show_hidden,
                respect_gitignore,
            },
        )
    })
    .await
    .map_err(err)?
    .map_err(err)
}

#[tauri::command]
async fn find_files(
    root: String,
    query: String,
    limit: usize,
    show_hidden: bool,
    respect_gitignore: bool,
) -> CmdResult<Vec<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        nimble_core::folder::find_files(
            Path::new(&root),
            &query,
            limit.clamp(1, 1000),
            300_000,
            nimble_core::folder::ListOptions {
                show_hidden,
                respect_gitignore,
            },
        )
    })
    .await
    .map_err(err)?
    .map_err(err)
}

// ---- large files ---------------------------------------------------------------

use nimble_core::largefile::{
    self, Direction, Hit, IndexOptions, IndexStatus, LargeFile, LargeQuery, LinesChunk, OpenInfo,
    SearchPos,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

struct LargeHandle {
    file: Arc<LargeFile>,
    cancel: Arc<AtomicBool>,
    closed: Arc<AtomicBool>,
}

#[derive(Default)]
struct LargeFiles(Mutex<(u64, std::collections::HashMap<u64, Arc<LargeHandle>>)>);

impl LargeFiles {
    fn get(&self, id: u64) -> CmdResult<Arc<LargeHandle>> {
        self.0
            .lock()
            .unwrap()
            .1
            .get(&id)
            .cloned()
            .ok_or_else(|| "the file is no longer open".to_string())
    }
}

/// Indexes in the background, one chunk at a time, until the whole file is done or the viewer closed.
fn spawn_indexer(h: Arc<LargeHandle>) {
    std::thread::spawn(move || {
        while !h.closed.load(Ordering::Relaxed) {
            match h.file.index_step(64 * 1024 * 1024) {
                Ok(st) if st.done => break,
                Ok(_) => {}
                Err(_) => break,
            }
        }
    });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileMeta {
    size: u64,
    /// Above the limit for normal editing: such files open in the read-only large-file viewer.
    large: bool,
}

#[tauri::command]
async fn file_meta(path: String) -> CmdResult<FileMeta> {
    let size = std::fs::metadata(&path).map_err(err)?.len();
    Ok(FileMeta {
        size,
        large: size > fileio::MAX_EDITABLE_BYTES,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LargeOpened {
    id: u64,
    info: OpenInfo,
    status: IndexStatus,
}

#[tauri::command]
async fn lf_open(
    files: State<'_, LargeFiles>,
    path: String,
    encoding: Option<TextEncoding>,
) -> CmdResult<LargeOpened> {
    let (file, info) = tauri::async_runtime::spawn_blocking(move || {
        LargeFile::open_with(Path::new(&path), IndexOptions::default(), encoding)
    })
    .await
    .map_err(err)?
    .map_err(err)?;
    let status = file.status();
    let handle = Arc::new(LargeHandle {
        file: Arc::new(file),
        cancel: Arc::default(),
        closed: Arc::default(),
    });
    let id = {
        let mut g = files.0.lock().unwrap();
        g.0 += 1;
        let id = g.0;
        g.1.insert(id, handle.clone());
        id
    };
    spawn_indexer(handle);
    Ok(LargeOpened { id, info, status })
}

#[tauri::command]
async fn lf_status(files: State<'_, LargeFiles>, id: u64) -> CmdResult<IndexStatus> {
    Ok(files.get(id)?.file.status())
}

#[tauri::command]
async fn lf_read(
    files: State<'_, LargeFiles>,
    id: u64,
    first: u64,
    count: usize,
    max_chars: usize,
) -> CmdResult<LinesChunk> {
    let h = files.get(id)?;
    tauri::async_runtime::spawn_blocking(move || {
        h.file
            .read_lines(first, count.min(500), max_chars.clamp(80, 20_000))
    })
    .await
    .map_err(err)?
    .map_err(err)
}

#[tauri::command]
async fn lf_search(
    files: State<'_, LargeFiles>,
    id: u64,
    query: LargeQuery,
    from: SearchPos,
    direction: Direction,
) -> CmdResult<Option<Hit>> {
    let h = files.get(id)?;
    h.cancel.store(false, Ordering::Relaxed);
    tauri::async_runtime::spawn_blocking(move || h.file.search(&query, from, direction, &h.cancel))
        .await
        .map_err(err)?
        .map_err(|e| {
            if largefile::is_cancelled(&e) {
                largefile::CANCELLED.to_string()
            } else {
                e.to_string()
            }
        })
}

#[tauri::command]
async fn lf_count(files: State<'_, LargeFiles>, id: u64, query: LargeQuery) -> CmdResult<u64> {
    let h = files.get(id)?;
    h.cancel.store(false, Ordering::Relaxed);
    tauri::async_runtime::spawn_blocking(move || {
        h.file.count_matches(&query, &h.cancel, &mut |_| {})
    })
    .await
    .map_err(err)?
    .map_err(|e| {
        if largefile::is_cancelled(&e) {
            largefile::CANCELLED.to_string()
        } else {
            e.to_string()
        }
    })
}

/// Stops a running search or count on this file.
#[tauri::command]
fn lf_cancel(files: State<'_, LargeFiles>, id: u64) {
    if let Ok(h) = files.get(id) {
        h.cancel.store(true, Ordering::Relaxed);
    }
}

/// Picks up appended data (follow mode) and restarts the indexer for the new part.
#[tauri::command]
async fn lf_refresh(files: State<'_, LargeFiles>, id: u64) -> CmdResult<IndexStatus> {
    let h = files.get(id)?;
    let h2 = h.clone();
    let st = tauri::async_runtime::spawn_blocking(move || h2.file.refresh())
        .await
        .map_err(err)?
        .map_err(err)?;
    if !st.done {
        spawn_indexer(h);
    }
    Ok(st)
}

#[tauri::command]
fn lf_close(files: State<'_, LargeFiles>, id: u64) {
    if let Some(h) = files.0.lock().unwrap().1.remove(&id) {
        h.closed.store(true, Ordering::Relaxed);
        h.cancel.store(true, Ordering::Relaxed);
    }
}

// ---- hashes -------------------------------------------------------------------

#[derive(Serialize)]
struct Digest {
    algorithm: nimble_core::hash::Algorithm,
    hex: String,
}

fn digests(r: Vec<(nimble_core::hash::Algorithm, String)>) -> Vec<Digest> {
    r.into_iter()
        .map(|(algorithm, hex)| Digest { algorithm, hex })
        .collect()
}

/// Digests of UTF-8 text (the editor's text, always with `\n` line breaks).
#[tauri::command]
async fn hash_text(
    text: String,
    algorithms: Vec<nimble_core::hash::Algorithm>,
) -> CmdResult<Vec<Digest>> {
    tauri::async_runtime::spawn_blocking(move || {
        nimble_core::hash::hash_reader(&algorithms, text.as_bytes())
    })
    .await
    .map_err(err)?
    .map(digests)
    .map_err(err)
}

/// Digests of a file's raw bytes.
#[tauri::command]
async fn hash_file(
    path: String,
    algorithms: Vec<nimble_core::hash::Algorithm>,
) -> CmdResult<Vec<Digest>> {
    tauri::async_runtime::spawn_blocking(move || {
        nimble_core::hash::hash_file(Path::new(&path), &algorithms)
    })
    .await
    .map_err(err)?
    .map(digests)
    .map_err(err)
}

// ---- compare -------------------------------------------------------------

/// Decoded texts of finished file comparisons, so the UI can fetch the lines of a hunk without
/// reading the files again.
type ComparedTexts = std::collections::HashMap<u64, (String, String)>;

#[derive(Default)]
struct CompareCache(Mutex<(u64, ComparedTexts)>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileComparison {
    id: u64,
    comparison: nimble_core::diff::Comparison,
    eol_a: Eol,
    eol_b: Eol,
}

/// Compares two texts (used for tabs that are too big for the in-page diff).
#[tauri::command]
async fn compare_text(
    a: String,
    b: String,
    options: nimble_core::diff::DiffOptions,
) -> CmdResult<nimble_core::diff::Comparison> {
    tauri::async_runtime::spawn_blocking(move || nimble_core::diff::compare(&a, &b, &options))
        .await
        .map_err(err)
}

/// Compares two files on disk and keeps their text for `compare_lines`.
#[tauri::command]
async fn compare_files(
    cache: State<'_, CompareCache>,
    a: String,
    b: String,
    options: nimble_core::diff::DiffOptions,
) -> CmdResult<FileComparison> {
    let (fa, fb) = tauri::async_runtime::spawn_blocking(move || -> nimble_core::Result<_> {
        Ok((
            fileio::read(Path::new(&a), Eol::Lf)?,
            fileio::read(Path::new(&b), Eol::Lf)?,
        ))
    })
    .await
    .map_err(err)?
    .map_err(err)?;
    let (eol_a, eol_b) = (fa.eol, fb.eol);
    let (ta, tb) = (fa.text, fb.text);
    let opts = options.clone();
    let (ta2, tb2) = (ta.clone(), tb.clone());
    let comparison =
        tauri::async_runtime::spawn_blocking(move || nimble_core::diff::compare(&ta2, &tb2, &opts))
            .await
            .map_err(err)?;
    let mut guard = cache.0.lock().unwrap();
    guard.0 += 1;
    let id = guard.0;
    // Keep only the latest few comparisons.
    if guard.1.len() >= 4 {
        let oldest = *guard.1.keys().min().unwrap();
        guard.1.remove(&oldest);
    }
    guard.1.insert(id, (ta, tb));
    Ok(FileComparison {
        id,
        comparison,
        eol_a,
        eol_b,
    })
}

/// Lines `[start, start + len)` of side `a` or `b` of a finished file comparison.
#[tauri::command]
async fn compare_lines(
    cache: State<'_, CompareCache>,
    id: u64,
    side: String,
    start: usize,
    len: usize,
) -> CmdResult<Vec<String>> {
    let guard = cache.0.lock().unwrap();
    let (a, b) = guard.1.get(&id).ok_or("comparison expired")?;
    Ok(nimble_core::diff::slice_lines(
        if side == "a" { a } else { b },
        start,
        len.min(2000),
    ))
}

#[tauri::command]
fn compare_close(cache: State<'_, CompareCache>, id: u64) {
    cache.0.lock().unwrap().1.remove(&id);
}

// ---- user-defined languages ------------------------------------------------

/// Validates a JSON or TOML definition and returns it normalised as JSON.
#[tauri::command]
async fn parse_language_definition(text: String, format: String) -> CmdResult<String> {
    let format: nimble_core::userlang::Format = format.parse().map_err(err)?;
    let def = nimble_core::userlang::parse_definition(&text, format).map_err(err)?;
    nimble_core::userlang::to_json(&def).map_err(err)
}

/// Converts a definition (JSON) to "json" or "toml" for export.
#[tauri::command]
async fn serialize_language_definition(json: String, format: String) -> CmdResult<String> {
    let format: nimble_core::userlang::Format = format.parse().map_err(err)?;
    let def = nimble_core::userlang::parse_definition(&json, nimble_core::userlang::Format::Json)
        .map_err(err)?;
    nimble_core::userlang::serialize(&def, format).map_err(err)
}

/// The commented starter template (TOML).
#[tauri::command]
fn language_template() -> String {
    nimble_core::userlang::starter_template()
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
    pending.take()
}

#[tauri::command]
fn set_locale(app: AppHandle, locale: String) -> CmdResult<()> {
    let m = menu::build(&app, &locale).map_err(err)?;
    app.set_menu(m).map_err(err)?;
    Ok(())
}

/// Called by the frontend once the first tab is painted. Records cold-start time
/// (process `run()` to usable window) plus the part spent in the page (`frontend_ms`).
/// With `NIMBLE_STARTUP_REPORT=<file>` it writes the numbers there and quits.
#[tauri::command]
fn app_ready(app: AppHandle, frontend_ms: f64, stages: serde_json::Value) {
    let ms = START
        .get()
        .map(|s| s.elapsed().as_secs_f64() * 1000.0)
        .unwrap_or(0.0);
    eprintln!(
        "nimble-newt: ready in {ms:.0} ms (page load to ready: {frontend_ms:.0} ms) {stages}"
    );
    if let Ok(path) = std::env::var("NIMBLE_STARTUP_REPORT") {
        let _ = std::fs::write(
            path,
            format!(
                "{{\"startup_ms\":{ms:.1},\"frontend_ms\":{frontend_ms:.1},\"stages\":{stages}}}"
            ),
        );
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
    if let Some(now) = app.state::<Pending>().deliver(paths) {
        let _ = app.emit("open-paths", now);
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
        .manage(CompareCache::default())
        .manage(LargeFiles::default())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            app.manage(SessionStore::new(dir).map_err(|e| e.to_string())?);
            let args = existing_files(
                std::env::args().skip(1),
                std::env::current_dir().ok().as_deref(),
            );
            app.state::<Pending>().deliver(args);
            app.set_menu(menu::build(app.handle(), "en")?)?;
            // The window starts hidden and the frontend shows it when ready. If the frontend never
            // gets that far, show it anyway so the user is not left with an invisible process.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(6));
                if let Some(w) = handle.get_webview_window("main") {
                    if !w.is_visible().unwrap_or(true) {
                        let _ = w.show();
                    }
                }
            });
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
            parse_language_definition,
            serialize_language_definition,
            language_template,
            list_encodings,
            compare_text,
            compare_files,
            compare_lines,
            compare_close,
            file_meta,
            list_dir,
            find_files,
            lf_open,
            lf_status,
            lf_read,
            lf_search,
            lf_count,
            lf_cancel,
            lf_refresh,
            lf_close,
            hash_text,
            hash_file,
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
    fn paths_before_ready_are_queued_and_taken_once() {
        let p = Pending::default();
        assert_eq!(p.deliver(vec!["a".into(), "b".into()]), None);
        assert_eq!(p.deliver(vec!["c".into()]), None);
        assert_eq!(p.take(), vec!["a", "b", "c"]);
        assert!(p.take().is_empty());
    }

    #[test]
    fn paths_after_ready_are_emitted_immediately() {
        let p = Pending::default();
        p.take();
        assert_eq!(p.deliver(vec!["x".into()]), Some(vec!["x".to_string()]));
        assert!(p.take().is_empty());
    }

    #[test]
    fn concurrent_delivery_never_loses_a_path() {
        use std::sync::Arc;
        for _ in 0..200 {
            let p = Arc::new(Pending::default());
            let sender = {
                let p = p.clone();
                std::thread::spawn(move || p.deliver(vec!["late".into()]))
            };
            let taken = p.take();
            let emitted = sender.join().unwrap();
            // Either the frontend got it from the queue or it is emitted as an event; never neither.
            assert!(taken.contains(&"late".to_string()) ^ emitted.is_some());
        }
    }

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
