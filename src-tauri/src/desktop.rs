use crate::{
    error::{Error, Result},
    git, history,
    models::*,
    service::{PreferencesPatch, Service},
};
use std::sync::Arc;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, State, Theme, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::DialogExt;

type Shared = Arc<Service>;
async fn read_action<T: Send + 'static>(
    state: State<'_, Shared>,
    f: impl FnOnce(&Service) -> Result<T> + Send + 'static,
) -> std::result::Result<T, String> {
    let service = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.read(f))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.message)
}
async fn action<T: Send + 'static>(
    state: State<'_, Shared>,
    f: impl FnOnce(&Service) -> Result<T> + Send + 'static,
) -> std::result::Result<T, String> {
    let service = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.run(f))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.message)
}
#[tauri::command]
async fn refresh(state: State<'_, Shared>) -> std::result::Result<AppState, String> {
    read_action(state, Service::refresh).await
}
#[tauri::command]
async fn add_repositories(
    app: AppHandle,
    state: State<'_, Shared>,
) -> std::result::Result<AddResult, String> {
    action(state, move |service| {
        let paths = app
            .dialog()
            .file()
            .set_title("Aggiungi repository")
            .blocking_pick_folders()
            .unwrap_or_default();
        let paths = paths
            .into_iter()
            .map(|file| {
                file.into_path()
                    .map(|path| path.to_string_lossy().into_owned())
                    .map_err(|e| Error::new(e.to_string()))
            })
            .collect::<Result<Vec<_>>>()?;
        service.add(paths)
    })
    .await
}
#[tauri::command]
async fn remove_repository(
    state: State<'_, Shared>,
    path: String,
) -> std::result::Result<Settings, String> {
    action(state, move |s| s.remove(&path)).await
}
#[tauri::command]
async fn reorder_repositories(
    state: State<'_, Shared>,
    paths: Vec<String>,
) -> std::result::Result<Settings, String> {
    action(state, move |s| s.reorder(paths)).await
}
#[tauri::command]
async fn rename_repository(
    state: State<'_, Shared>,
    path: String,
    name: String,
) -> std::result::Result<Settings, String> {
    action(state, move |s| s.rename(&path, &name)).await
}
#[tauri::command]
async fn save_preferences(
    app: AppHandle,
    state: State<'_, Shared>,
    preferences: PreferencesPatch,
) -> std::result::Result<Settings, String> {
    let settings = action(state, move |s| s.preferences(preferences)).await?;
    app.set_theme(theme(&settings.preferences.theme));
    Ok(settings)
}
#[tauri::command]
async fn get_diff(
    state: State<'_, Shared>,
    path: String,
    key: String,
) -> std::result::Result<DiffResult, String> {
    read_action(state, move |s| s.diff(&path, &key)).await
}
#[tauri::command]
async fn get_history(
    state: State<'_, Shared>,
    path: String,
    cursor: Option<HistoryCursor>,
) -> std::result::Result<HistoryPage, String> {
    read_action(state, move |s| {
        history::get_history_page(&s.repository(&path)?, cursor.as_ref())
    })
    .await
}
#[tauri::command]
async fn get_commit_diff(
    state: State<'_, Shared>,
    path: String,
    hash: String,
    key: String,
) -> std::result::Result<DiffResult, String> {
    read_action(state, move |s| s.commit_diff(&path, &hash, &key)).await
}
#[tauri::command]
async fn get_local_status(
    state: State<'_, Shared>,
    path: String,
) -> std::result::Result<RepositoryStatus, String> {
    read_action(state, move |s| {
        Ok(history::get_local_status(&s.repository(&path)?))
    })
    .await
}
#[tauri::command]
async fn stage(
    state: State<'_, Shared>,
    path: String,
    target: ChangeTarget,
) -> std::result::Result<RepositoryStatus, String> {
    action(state, move |s| s.move_changes(&path, Some(&target), true)).await
}
#[tauri::command]
async fn unstage(
    state: State<'_, Shared>,
    path: String,
    target: ChangeTarget,
) -> std::result::Result<RepositoryStatus, String> {
    action(state, move |s| s.move_changes(&path, Some(&target), false)).await
}
#[tauri::command]
async fn stage_all(
    state: State<'_, Shared>,
    path: String,
) -> std::result::Result<RepositoryStatus, String> {
    action(state, move |s| s.move_changes(&path, None, true)).await
}
#[tauri::command]
async fn unstage_all(
    state: State<'_, Shared>,
    path: String,
) -> std::result::Result<RepositoryStatus, String> {
    action(state, move |s| s.move_changes(&path, None, false)).await
}
#[tauri::command]
async fn commit(
    state: State<'_, Shared>,
    path: String,
    message: String,
) -> std::result::Result<(), String> {
    action(state, move |s| {
        git::commit_staged(&s.repository(&path)?, &message)
    })
    .await
}

fn theme(value: &str) -> Option<Theme> {
    match value {
        "dark" => Some(Theme::Dark),
        "light" => Some(Theme::Light),
        _ => None,
    }
}
fn create_window(app: &AppHandle) -> tauri::Result<()> {
    let builder = WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
        .on_navigation(|url| {
            (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                || (cfg!(debug_assertions)
                    && url.scheme() == "http"
                    && url.host_str() == Some("127.0.0.1")
                    && url.port() == Some(1420))
        });
    #[cfg(feature = "smoke")]
    let builder = builder.initialization_script(include_str!("../../scripts/native-smoke.js"));
    builder.build()?;
    Ok(())
}
fn install_menu(app: &AppHandle) -> tauri::Result<()> {
    let quit = MenuItemBuilder::with_id("quit", "Esci da RepoPeek")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    let add = MenuItemBuilder::with_id("add", "Aggiungi repository…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let refresh = MenuItemBuilder::with_id("refresh", "Aggiorna")
        .accelerator("CmdOrCtrl+R")
        .build(app)?;
    let application = SubmenuBuilder::new(app, "RepoPeek")
        .about(None)
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .item(&quit)
        .build()?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&add)
        .item(&refresh)
        .separator()
        .close_window()
        .build()?;
    let edit = SubmenuBuilder::new(app, "Modifica")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let window = SubmenuBuilder::new(app, "Finestra")
        .minimize()
        .maximize()
        .build()?;
    app.set_menu(
        MenuBuilder::new(app)
            .items(&[&application, &file, &edit, &window])
            .build()?,
    )?;
    Ok(())
}
#[cfg(feature = "smoke")]
#[tauri::command]
fn smoke_complete(app: AppHandle, report: serde_json::Value) -> std::result::Result<(), String> {
    let file = std::env::var("REPOPEEK_SMOKE_REPORT").map_err(|e| e.to_string())?;
    std::fs::write(
        file,
        serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    app.exit(if report["ok"] == true { 0 } else { 1 });
    Ok(())
}
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let directory = app.path().data_dir()?.join("RepoPeek");
            #[cfg(any(debug_assertions, feature = "smoke"))]
            let directory = std::env::var_os("REPOPEEK_USER_DATA")
                .map(std::path::PathBuf::from)
                .unwrap_or(directory);
            let service = Arc::new(Service::new(directory.join("config/settings.json")));
            let settings = service.settings()?;
            app.set_theme(theme(&settings.preferences.theme));
            app.manage(service);
            install_menu(app.handle())?;
            create_window(app.handle())?;
            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "quit" => app.exit(0),
            "add" | "refresh" => {
                if app.get_webview_window("main").is_none() {
                    let _ = create_window(app);
                }
                let name = if event.id().as_ref() == "add" {
                    "repopeek:add-requested"
                } else {
                    "repopeek:refresh-requested"
                };
                let _ = app.emit_to("main", name, ());
            }
            _ => {}
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Focused(true) = event {
                let _ = window.emit("repopeek:refresh-requested", ());
            }
        });
    #[cfg(not(feature = "smoke"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        refresh,
        add_repositories,
        remove_repository,
        reorder_repositories,
        rename_repository,
        save_preferences,
        get_diff,
        get_history,
        get_commit_diff,
        get_local_status,
        stage,
        unstage,
        stage_all,
        unstage_all,
        commit
    ]);
    #[cfg(feature = "smoke")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        refresh,
        add_repositories,
        remove_repository,
        reorder_repositories,
        rename_repository,
        save_preferences,
        get_diff,
        get_history,
        get_commit_diff,
        get_local_status,
        stage,
        unstage,
        stage_all,
        unstage_all,
        commit,
        smoke_complete
    ]);
    builder
        .build(tauri::generate_context!())
        .expect("Avvio RepoPeek non riuscito.")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } => api.prevent_exit(),
            tauri::RunEvent::Reopen { .. } => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                } else {
                    let _ = create_window(app);
                }
            }
            _ => {}
        });
}
