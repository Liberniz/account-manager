mod platform;
mod providers;
mod session_manager;
mod storage;
mod updater;

use session_manager::{ManagerSnapshot, SessionManager, APP_TITLE};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use updater::{InstallUpdateOutcome, InstallUpdateRequest, UpdateCheckResult};

#[tauri::command]
async fn get_manager_state(mgr: State<'_, Arc<SessionManager>>) -> Result<ManagerSnapshot, String> {
  Ok(mgr.get_snapshot().await)
}

#[tauri::command]
async fn select_provider(
  app: AppHandle,
  mgr: State<'_, Arc<SessionManager>>,
  provider_id: String,
) -> Result<ManagerSnapshot, String> {
  mgr.select_provider(&app, &provider_id).await
}

#[tauri::command]
async fn add_account(
  app: AppHandle,
  mgr: State<'_, Arc<SessionManager>>,
  provider_id: String,
  alias: String,
) -> Result<ManagerSnapshot, String> {
  mgr.add_account(&app, &provider_id, &alias).await
}

#[tauri::command]
async fn rename_account(
  app: AppHandle,
  mgr: State<'_, Arc<SessionManager>>,
  provider_id: String,
  uuid: String,
  alias: String,
) -> Result<ManagerSnapshot, String> {
  mgr.rename_account(&app, &provider_id, &uuid, &alias).await
}

#[tauri::command]
async fn remove_account(
  app: AppHandle,
  mgr: State<'_, Arc<SessionManager>>,
  provider_id: String,
  uuid: String,
) -> Result<ManagerSnapshot, String> {
  mgr.remove_account(&app, &provider_id, &uuid).await
}

#[tauri::command]
async fn switch_account(
  app: AppHandle,
  mgr: State<'_, Arc<SessionManager>>,
  provider_id: String,
  uuid: String,
) -> Result<ManagerSnapshot, String> {
  mgr.switch_account(&app, &provider_id, &uuid).await
}

#[tauri::command]
async fn set_modal_active(
  app: AppHandle,
  mgr: State<'_, Arc<SessionManager>>,
  active: bool,
) -> Result<ManagerSnapshot, String> {
  mgr.set_modal_active(&app, active).await
}

#[tauri::command]
async fn open_official_site(
  app: AppHandle,
  mgr: State<'_, Arc<SessionManager>>,
  provider_id: String,
) -> Result<ManagerSnapshot, String> {
  mgr.open_official_site(&app, &provider_id).await
}

#[tauri::command]
async fn resolve_uuid_conflict(
  mgr: State<'_, Arc<SessionManager>>,
  keep_provider_id: String,
  uuid: String,
) -> Result<ManagerSnapshot, String> {
  mgr.resolve_uuid_conflict(&keep_provider_id, &uuid).await
}

#[tauri::command]
async fn dismiss_notice(mgr: State<'_, Arc<SessionManager>>) -> Result<ManagerSnapshot, String> {
  Ok(mgr.dismiss_notice().await)
}

#[tauri::command]
async fn set_proxy_url(
  app: AppHandle,
  mgr: State<'_, Arc<SessionManager>>,
  proxy_url: String,
) -> Result<ManagerSnapshot, String> {
  mgr.set_proxy_url(&app, &proxy_url).await
}

#[tauri::command]
async fn set_proxy_follow_system(
  app: AppHandle,
  mgr: State<'_, Arc<SessionManager>>,
  enabled: bool,
) -> Result<ManagerSnapshot, String> {
  mgr.set_proxy_follow_system(&app, enabled).await
}

#[tauri::command]
async fn set_warm_view_limit(
  app: AppHandle,
  mgr: State<'_, Arc<SessionManager>>,
  limit: Option<u32>,
) -> Result<ManagerSnapshot, String> {
  mgr.set_warm_view_limit(&app, limit).await
}

#[tauri::command]
async fn trigger_quota_sync(
  app: AppHandle,
  mgr: State<'_, Arc<SessionManager>>,
) -> Result<ManagerSnapshot, String> {
  mgr.trigger_silent_sync(&app, true).await;
  Ok(mgr.get_snapshot().await)
}

#[tauri::command]
async fn check_for_updates(app: AppHandle) -> Result<UpdateCheckResult, String> {
  updater::check_for_updates(&app).await
}

#[tauri::command]
async fn download_and_install_update(
  app: AppHandle,
  request: InstallUpdateRequest,
) -> Result<InstallUpdateOutcome, String> {
  updater::download_and_install_update(&app, request).await
}

#[tauri::command]
async fn open_external_url(app: AppHandle, url: String) -> Result<(), String> {
  updater::open_external_url(&app, &url).await
}

pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      let app_data_dir = app.path().app_data_dir()?;
      let session_mgr = Arc::new(SessionManager::new(app_data_dir));
      app.manage(Arc::clone(&session_mgr));

      // 菜单栏常驻图标：菜单含账号列表（点击直接切换），内容随状态快照刷新。
      {
        use tauri::menu::{Menu, MenuItem};
        use tauri::tray::TrayIconBuilder;
        let show_item = MenuItem::with_id(app, "tray-show", "显示叠号", true, None::<&str>)?;
        let quit_item = MenuItem::with_id(app, "tray-quit", "退出叠号", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
        let mut tray_builder = TrayIconBuilder::with_id("main-tray")
          .menu(&menu)
          .show_menu_on_left_click(true)
          .tooltip("叠号")
          .on_menu_event(|app, event| {
            let id = event.id.as_ref();
            if id == "tray-show" {
              if let Some(win) = app.get_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
              }
            } else if id == "tray-quit" {
              app.exit(0);
            } else if let Some(uuid) = id.strip_prefix("tray-acc:") {
              let app_handle = app.clone();
              let uuid = uuid.to_string();
              tauri::async_runtime::spawn(async move {
                if let Some(win) = app_handle.get_window("main") {
                  let _ = win.show();
                  let _ = win.set_focus();
                }
                let mgr = app_handle.state::<Arc<SessionManager>>();
                let _ = mgr.switch_account(&app_handle, "muse", &uuid).await;
              });
            }
          });
        if let Some(icon) = app.default_window_icon() {
          tray_builder = tray_builder.icon(icon.clone());
        }
        tray_builder.build(app)?;
      }

      {
        let main_window = tauri::window::WindowBuilder::new(app, "main")
          .title(APP_TITLE)
          .inner_size(1240.0, 800.0)
          .min_inner_size(760.0, 520.0)
          .build()?;

        let manager_builder =
          tauri::webview::WebviewBuilder::new("manager", tauri::WebviewUrl::App("index.html".into()))
            .on_navigation(|url| {
              url.scheme() == "tauri"
                || url.domain() == Some("tauri.localhost")
                || (cfg!(dev) && url.host_str() == Some("localhost"))
            });

        main_window.add_child(
          manager_builder,
          tauri::LogicalPosition::new(0.0, 0.0),
          tauri::LogicalSize::new(1240.0, 800.0),
        )?;

        let app_for_resize = app.handle().clone();
        let mgr_for_resize = Arc::clone(&session_mgr);
        main_window.on_window_event(move |event| match event {
          tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. } => {
            let app_inner = app_for_resize.clone();
            let mgr_inner = Arc::clone(&mgr_for_resize);
            tauri::async_runtime::spawn(async move {
              mgr_inner.recompute_desktop_bounds(&app_inner).await;
            });
          }
          tauri::WindowEvent::Focused(focused) if *focused => {
            let app_inner = app_for_resize.clone();
            let mgr_inner = Arc::clone(&mgr_for_resize);
            tauri::async_runtime::spawn(async move {
              mgr_inner.trigger_silent_sync(&app_inner, false).await;
            });
          }
          _ => {}
        });
      }

      let app_for_boot = app.handle().clone();
      let mgr_for_boot = Arc::clone(&session_mgr);
      tauri::async_runtime::spawn(async move {
        mgr_for_boot.run_startup_tasks(&app_for_boot).await;
      });

      let app_for_tray = app.handle().clone();
      let mgr_for_tray = Arc::clone(&session_mgr);
      tauri::async_runtime::spawn(async move {
        let snap = mgr_for_tray.get_snapshot().await;
        SessionManager::refresh_tray_menu(&app_for_tray, &snap);
      });

      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      get_manager_state,
      select_provider,
      add_account,
      rename_account,
      remove_account,
      switch_account,
      set_modal_active,
      open_official_site,
      resolve_uuid_conflict,
      dismiss_notice,
      set_proxy_url,
      set_warm_view_limit,
      set_proxy_follow_system,
      trigger_quota_sync,
      check_for_updates,
      download_and_install_update,
      open_external_url,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
