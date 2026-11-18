use crate::platform::{self, current_platform_name};
use crate::providers::{
  all_provider_infos, classify_top_level_url, get_provider, is_verified_callback_origin,
  NavigationDecision, ProviderId, ProviderInfo,
};
use crate::storage::{
  detect_conflicts, load_or_migrate_store, normalize_uuid, now_ms, save_store_atomic, AccountKey,
  AccountRecord, AccountsStoreFile, ConflictItem,
};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;
use url::Url;
use uuid::Uuid;

pub const APP_TITLE: &str = "多 Agent 账号管理器";
#[cfg(desktop)]
const LEFT_PANE_WIDTH: f64 = 360.0;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagerSnapshot {
  pub platform: &'static str,
  pub providers: Vec<ProviderInfo>,
  pub accounts: Vec<AccountRecord>,
  pub selected_provider_id: ProviderId,
  pub active_account: Option<AccountKey>,
  pub switching_account: Option<AccountKey>,
  pub last_committed: Option<AccountKey>,
  pub pending_cleanup: Vec<AccountKey>,
  pub conflicts: Vec<ConflictItem>,
  pub notice: Option<String>,
  pub modal_active: bool,
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
struct PendingExternalAuth {
  account_key: AccountKey,
  switch_seq: u64,
  nonce: String,
}

struct ActiveSessionSlot {
  account_key: AccountKey,
  view_instance_id: u64,
  switch_seq: u64,
  committed: bool,
  #[cfg(desktop)]
  webview_label: String,
  #[cfg(desktop)]
  popup_label: Option<String>,
}

struct InnerState {
  store_path: PathBuf,
  app_data_dir: PathBuf,
  store: AccountsStoreFile,
  conflicts: Vec<ConflictItem>,
  selected_provider_id: ProviderId,
  active_slot: Option<ActiveSessionSlot>,
  pending_external_auth: Option<PendingExternalAuth>,
  notice: Option<String>,
  modal_active: bool,
}

pub struct SessionManager {
  current_seq: Arc<AtomicU64>,
  view_counter: AtomicU64,
  inner: Mutex<InnerState>,
}

impl SessionManager {
  pub fn new(app_data_dir: PathBuf) -> Self {
    let store_path = app_data_dir.join("accounts.json");
    let loaded = load_or_migrate_store(&store_path);
    let initial_provider = loaded
      .store
      .last_committed
      .as_ref()
      .map(|k| k.provider_id)
      .filter(|pid| get_provider(*pid).info.enabled)
      .unwrap_or(ProviderId::Muse);

    Self {
      current_seq: Arc::new(AtomicU64::new(1)),
      view_counter: AtomicU64::new(1),
      inner: Mutex::new(InnerState {
        store_path,
        app_data_dir,
        store: loaded.store,
        conflicts: loaded.conflicts,
        selected_provider_id: initial_provider,
        active_slot: None,
        pending_external_auth: None,
        notice: loaded.startup_notice,
        modal_active: false,
      }),
    }
  }

  fn snapshot_from_locked(locked: &InnerState) -> ManagerSnapshot {
    let (active_account, switching_account) = match &locked.active_slot {
      Some(slot) if slot.committed => (Some(slot.account_key.clone()), None),
      Some(slot) => (None, Some(slot.account_key.clone())),
      None => (None, None),
    };

    ManagerSnapshot {
      platform: current_platform_name(),
      providers: all_provider_infos(),
      accounts: locked.store.accounts.clone(),
      selected_provider_id: locked.selected_provider_id,
      active_account,
      switching_account,
      last_committed: locked.store.last_committed.clone(),
      pending_cleanup: locked.store.pending_cleanup.clone(),
      conflicts: locked.conflicts.clone(),
      notice: locked.notice.clone(),
      modal_active: locked.modal_active,
    }
  }

  fn emit_snapshot(&self, app: &AppHandle, snap: &ManagerSnapshot) {
    let _ = app.emit("manager-state-changed", snap);
  }

  pub async fn get_snapshot(&self) -> ManagerSnapshot {
    let locked = self.inner.lock().await;
    Self::snapshot_from_locked(&locked)
  }

  pub async fn run_startup_tasks(self: &Arc<Self>, app: &AppHandle) {
    #[cfg(target_os = "android")]
    {
      let mgr = Arc::clone(self);
      let app_clone = app.clone();
      let channel = tauri::ipc::Channel::new(move |body| {
        if let tauri::ipc::InvokeResponseBody::Json(raw_json) = body {
          if let Ok(evt) =
            serde_json::from_str::<crate::platform::android::AndroidSessionEvent>(&raw_json)
          {
            let mgr_inner = Arc::clone(&mgr);
            let app_inner = app_clone.clone();
            tauri::async_runtime::spawn(async move {
              mgr_inner.handle_android_event(&app_inner, evt).await;
            });
          }
        }
        Ok(())
      });
      let _ = crate::platform::android::subscribe_events(app, channel).await;
    }

    self.retry_pending_cleanups(app).await;

    let candidate = {
      let mut locked = self.inner.lock().await;
      if !locked.conflicts.is_empty() || locked.notice.is_some() {
        None
      } else if let Some(key) = locked.store.last_committed.clone() {
        let in_cleanup = locked.store.pending_cleanup.contains(&key);
        let exists = locked
          .store
          .accounts
          .iter()
          .any(|a| a.provider_id == key.provider_id && a.uuid == key.uuid);
        let enabled = get_provider(key.provider_id).info.enabled;
        if in_cleanup || !exists {
          locked.store.last_committed = None;
          let _ = save_store_atomic(&locked.store_path, &locked.store);
          locked.notice = Some("上次记录的账号键不存在或已清理，已回到管理页".to_string());
          None
        } else if !enabled {
          None
        } else {
          locked.selected_provider_id = key.provider_id;
          Some(key)
        }
      } else {
        None
      }
    };

    if let Some(key) = candidate {
      let _ = self.switch_account_internal(app, key, true).await;
    } else {
      let snap = self.get_snapshot().await;
      self.emit_snapshot(app, &snap);
    }
  }

  async fn retry_pending_cleanups(&self, app: &AppHandle) {
    let keys = {
      let locked = self.inner.lock().await;
      locked.store.pending_cleanup.clone()
    };
    if keys.is_empty() {
      return;
    }

    for key in keys {
      let deleted = self.delete_profile_for_key(app, &key.uuid).await;
      if deleted.is_ok() {
        let mut locked = self.inner.lock().await;
        locked.store.pending_cleanup.retain(|k| k != &key);
        let _ = save_store_atomic(&locked.store_path, &locked.store);
      }
    }
  }

  async fn delete_profile_for_key(&self, app: &AppHandle, uuid_str: &str) -> Result<(), String> {
    #[cfg(desktop)]
    {
      let app_data_dir = {
        let locked = self.inner.lock().await;
        locked.app_data_dir.clone()
      };
      platform::delete_desktop_profile(app, &app_data_dir, uuid_str).await
    }
    #[cfg(target_os = "android")]
    {
      crate::platform::android::delete_profile(app, uuid_str).await
    }
    #[cfg(all(not(desktop), not(target_os = "android")))]
    {
      let _ = (app, uuid_str);
      Ok(())
    }
  }

  #[cfg(desktop)]
  fn teardown_desktop_slot(app: &AppHandle, slot: ActiveSessionSlot) {
    if let Some(popup_label) = slot.popup_label {
      if let Some(popup_win) = app.get_webview_window(&popup_label) {
        let _ = popup_win.close();
      }
    }
    if let Some(wv) = app.get_webview(&slot.webview_label) {
      let _ = wv.eval(
        "try{document.documentElement.inert=true;document.activeElement?.blur?.();}catch(_){}",
      );
      let _ = wv.hide();
      let _ = wv.close();
    }
    if let Some(main_win) = app.get_window("main") {
      let _ = main_win.set_title(APP_TITLE);
    }
  }

  async fn teardown_current_slot(&self, app: &AppHandle, next_seq: u64, locked: &mut InnerState) {
    locked.pending_external_auth = None;
    if let Some(old_slot) = locked.active_slot.take() {
      #[cfg(desktop)]
      {
        let _ = next_seq;
        Self::teardown_desktop_slot(app, old_slot);
      }
      #[cfg(target_os = "android")]
      {
        let _ = old_slot;
        let _ = crate::platform::android::close_active_session(app, next_seq).await;
      }
    } else {
      #[cfg(desktop)]
      if let Some(main_win) = app.get_window("main") {
        let _ = main_win.set_title(APP_TITLE);
      }
    }

    #[cfg(desktop)]
    Self::apply_desktop_layout_locked(app, locked);
  }

  #[cfg(desktop)]
  fn set_right_webview_input_frozen(webview: &tauri::Webview, frozen: bool) {
    #[cfg(windows)]
    {
      let _ = webview.with_webview(move |pwv| unsafe {
        let mut hwnd = windows::Win32::Foundation::HWND::default();
        if pwv.controller().ParentWindow(&mut hwnd).is_ok() && !hwnd.0.is_null() {
          let _ = windows::Win32::UI::Input::KeyboardAndMouse::EnableWindow(hwnd, !frozen);
        }
      });
    }

    if frozen {
      let _ = webview.eval(
        r#"(() => {
          try {
            document.documentElement.inert = true;
            document.activeElement?.blur?.();
            if (!document.getElementById('__mgr_freeze_shield__')) {
              const s = document.createElement('div');
              s.id = '__mgr_freeze_shield__';
              s.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:transparent;cursor:not-allowed;';
              for (const ev of ['mousedown','mouseup','click','keydown','keyup','keypress','focusin','wheel','touchstart']) {
                s.addEventListener(ev, (e) => { e.stopImmediatePropagation(); e.preventDefault(); }, true);
              }
              document.documentElement.appendChild(s);
            }
          } catch (_) {}
        })()"#,
      );
    } else {
      let _ = webview.eval(
        r#"(() => {
          try {
            document.documentElement.inert = false;
            document.getElementById('__mgr_freeze_shield__')?.remove();
          } catch (_) {}
        })()"#,
      );
    }
  }

  #[cfg(desktop)]
  fn apply_desktop_layout_locked(app: &AppHandle, locked: &InnerState) {
    let Some(main_win) = app.get_window("main") else {
      return;
    };
    let Ok(phys_size) = main_win.inner_size() else {
      return;
    };
    let Ok(scale) = main_win.scale_factor() else {
      return;
    };
    let win_w = (phys_size.width as f64) / scale;
    let win_h = (phys_size.height as f64) / scale;

    let show_right = locked
      .active_slot
      .as_ref()
      .map(|s| s.committed)
      .unwrap_or(false);

    if show_right {
      let left_w = win_w.min(LEFT_PANE_WIDTH);
      let right_w = (win_w - left_w).max(0.0);

      if let Some(mgr_wv) = app.get_webview("manager") {
        let _ = mgr_wv.set_bounds(tauri::Rect {
          position: tauri::LogicalPosition::new(0.0, 0.0).into(),
          size: tauri::LogicalSize::new(left_w, win_h).into(),
        });
      }

      if let Some(slot) = &locked.active_slot {
        if let Some(acc_wv) = app.get_webview(&slot.webview_label) {
          if right_w <= 1.0 {
            let _ = acc_wv.hide();
          } else {
            let _ = acc_wv.set_bounds(tauri::Rect {
              position: tauri::LogicalPosition::new(left_w, 0.0).into(),
              size: tauri::LogicalSize::new(right_w, win_h).into(),
            });
            let _ = acc_wv.show();
          }
          Self::set_right_webview_input_frozen(&acc_wv, locked.modal_active);
          if locked.modal_active {
            if let Some(mgr_wv) = app.get_webview("manager") {
              let _ = mgr_wv.set_focus();
            }
          }
        }
      }
    } else {
      if let Some(slot) = &locked.active_slot {
        if let Some(acc_wv) = app.get_webview(&slot.webview_label) {
          let _ = acc_wv.hide();
        }
      }
      if let Some(mgr_wv) = app.get_webview("manager") {
        let _ = mgr_wv.set_bounds(tauri::Rect {
          position: tauri::LogicalPosition::new(0.0, 0.0).into(),
          size: tauri::LogicalSize::new(win_w, win_h).into(),
        });
      }
    }
  }

  #[cfg(desktop)]
  pub async fn recompute_desktop_bounds(&self, app: &AppHandle) {
    let locked = self.inner.lock().await;
    Self::apply_desktop_layout_locked(app, &locked);
  }

  pub async fn select_provider(&self, app: &AppHandle, raw_provider: &str) -> Result<ManagerSnapshot, String> {
    let provider_id = ProviderId::parse(raw_provider).ok_or_else(|| "无效的服务标识".to_string())?;
    let next_seq = self.current_seq.fetch_add(1, Ordering::SeqCst) + 1;
    let mut locked = self.inner.lock().await;
    locked.selected_provider_id = provider_id;
    self.teardown_current_slot(app, next_seq, &mut locked).await;
    Ok(Self::snapshot_from_locked(&locked))
  }

  pub async fn add_account(
    &self,
    raw_provider: &str,
    raw_alias: &str,
  ) -> Result<ManagerSnapshot, String> {
    let provider_id = ProviderId::parse(raw_provider).ok_or_else(|| "无效的服务标识".to_string())?;
    if !get_provider(provider_id).info.enabled {
      return Err(format!("{} 当前待接入，暂不支持添加内嵌账号", get_provider(provider_id).info.name));
    }
    let alias = raw_alias.trim();
    if alias.is_empty() {
      return Err("账号别名不能为空".to_string());
    }

    let mut locked = self.inner.lock().await;
    if !locked.conflicts.is_empty() {
      return Err("请先处理 UUID 归属冲突后再新增账号".to_string());
    }

    let uuid = loop {
      let candidate = Uuid::new_v4().hyphenated().to_string();
      let used_in_accounts = locked.store.accounts.iter().any(|a| a.uuid == candidate);
      let used_in_cleanup = locked.store.pending_cleanup.iter().any(|k| k.uuid == candidate);
      if !used_in_accounts && !used_in_cleanup {
        break candidate;
      }
    };

    locked.store.accounts.push(AccountRecord {
      provider_id,
      uuid,
      alias: alias.to_string(),
      created_at_ms: now_ms(),
    });
    save_store_atomic(&locked.store_path, &locked.store)?;
    locked.selected_provider_id = provider_id;
    Ok(Self::snapshot_from_locked(&locked))
  }

  pub async fn rename_account(
    &self,
    app: &AppHandle,
    raw_provider: &str,
    raw_uuid: &str,
    raw_alias: &str,
  ) -> Result<ManagerSnapshot, String> {
    let provider_id = ProviderId::parse(raw_provider).ok_or_else(|| "无效的服务标识".to_string())?;
    let uuid = normalize_uuid(raw_uuid).ok_or_else(|| "无效的账号 UUID".to_string())?;
    let alias = raw_alias.trim();
    if alias.is_empty() {
      return Err("账号别名不能为空".to_string());
    }

    let mut locked = self.inner.lock().await;
    let target = locked
      .store
      .accounts
      .iter_mut()
      .find(|a| a.provider_id == provider_id && a.uuid == uuid)
      .ok_or_else(|| "未找到匹配的账号记录，拒绝跨服务改名".to_string())?;
    target.alias = alias.to_string();
    save_store_atomic(&locked.store_path, &locked.store)?;

    if let Some(slot) = &locked.active_slot {
      if slot.committed && slot.account_key.provider_id == provider_id && slot.account_key.uuid == uuid {
        let title = format!("{} · {}", get_provider(provider_id).info.short_name, alias);
        #[cfg(desktop)]
        if let Some(main_win) = app.get_window("main") {
          let _ = main_win.set_title(&title);
        }
        #[cfg(target_os = "android")]
        {
          let _ = crate::platform::android::update_account_title(app, slot.switch_seq, &title).await;
        }
      }
    }

    Ok(Self::snapshot_from_locked(&locked))
  }

  pub async fn remove_account(
    &self,
    app: &AppHandle,
    raw_provider: &str,
    raw_uuid: &str,
  ) -> Result<ManagerSnapshot, String> {
    let provider_id = ProviderId::parse(raw_provider).ok_or_else(|| "无效的服务标识".to_string())?;
    let uuid = normalize_uuid(raw_uuid).ok_or_else(|| "无效的账号 UUID".to_string())?;
    let key = AccountKey {
      provider_id,
      uuid: uuid.clone(),
    };

    let should_teardown = {
      let mut locked = self.inner.lock().await;
      if !locked.conflicts.is_empty() {
        return Err("存在 UUID 归属冲突，请先完成归属裁决".to_string());
      }
      let idx = locked
        .store
        .accounts
        .iter()
        .position(|a| a.provider_id == provider_id && a.uuid == uuid)
        .ok_or_else(|| "账号归属核对失败，未找到该账号".to_string())?;

      locked.store.accounts.remove(idx);
      if locked.store.last_committed.as_ref() == Some(&key) {
        locked.store.last_committed = None;
      }
      if !locked.store.pending_cleanup.contains(&key) {
        locked.store.pending_cleanup.push(key.clone());
      }
      save_store_atomic(&locked.store_path, &locked.store)?;

      let active_matches = locked
        .active_slot
        .as_ref()
        .map(|s| s.account_key == key)
        .unwrap_or(false);
      if active_matches {
        let next_seq = self.current_seq.fetch_add(1, Ordering::SeqCst) + 1;
        self.teardown_current_slot(app, next_seq, &mut locked).await;
      }
      active_matches
    };
    let _ = should_teardown;

    if self.delete_profile_for_key(app, &uuid).await.is_ok() {
      let mut locked = self.inner.lock().await;
      locked.store.pending_cleanup.retain(|k| k != &key);
      let _ = save_store_atomic(&locked.store_path, &locked.store);
    }

    Ok(self.get_snapshot().await)
  }

  pub async fn set_modal_active(
    &self,
    app: &AppHandle,
    active: bool,
  ) -> Result<ManagerSnapshot, String> {
    let mut locked = self.inner.lock().await;
    locked.modal_active = active;
    #[cfg(desktop)]
    Self::apply_desktop_layout_locked(app, &locked);
    #[cfg(not(desktop))]
    let _ = app;
    Ok(Self::snapshot_from_locked(&locked))
  }

  pub async fn open_official_site(
    &self,
    app: &AppHandle,
    raw_provider: &str,
  ) -> Result<ManagerSnapshot, String> {
    let provider_id = ProviderId::parse(raw_provider).ok_or_else(|| "无效的服务标识".to_string())?;
    let homepage = get_provider(provider_id).info.homepage_url;

    #[cfg(desktop)]
    {
      let _ = app;
      platform::open_external_browser(homepage)?;
    }
    #[cfg(target_os = "android")]
    {
      crate::platform::android::open_external_url(app, homepage).await?;
    }

    Ok(self.get_snapshot().await)
  }

  pub async fn resolve_uuid_conflict(
    &self,
    keep_provider_raw: &str,
    raw_uuid: &str,
  ) -> Result<ManagerSnapshot, String> {
    let keep_provider =
      ProviderId::parse(keep_provider_raw).ok_or_else(|| "无效的服务标识".to_string())?;
    let uuid = normalize_uuid(raw_uuid).ok_or_else(|| "无效的账号 UUID".to_string())?;

    let mut locked = self.inner.lock().await;
    let mut kept_first = false;
    for acc in &mut locked.store.accounts {
      if acc.uuid == uuid {
        if acc.provider_id == keep_provider && !kept_first {
          kept_first = true;
        } else {
          acc.uuid = Uuid::new_v4().hyphenated().to_string();
        }
      }
    }
    locked.conflicts = detect_conflicts(&locked.store.accounts);
    if locked.conflicts.is_empty() {
      locked.notice = None;
    }
    save_store_atomic(&locked.store_path, &locked.store)?;
    Ok(Self::snapshot_from_locked(&locked))
  }

  pub async fn dismiss_notice(&self) -> ManagerSnapshot {
    let mut locked = self.inner.lock().await;
    locked.notice = None;
    Self::snapshot_from_locked(&locked)
  }

  pub async fn switch_account(
    self: &Arc<Self>,
    app: &AppHandle,
    raw_provider: &str,
    raw_uuid: &str,
  ) -> Result<ManagerSnapshot, String> {
    let provider_id = ProviderId::parse(raw_provider).ok_or_else(|| "无效的服务标识".to_string())?;
    let uuid = normalize_uuid(raw_uuid).ok_or_else(|| "无效的账号 UUID".to_string())?;
    let key = AccountKey { provider_id, uuid };
    self.switch_account_internal(app, key, false).await
  }

  async fn switch_account_internal(
    self: &Arc<Self>,
    app: &AppHandle,
    key: AccountKey,
    is_cold_start: bool,
  ) -> Result<ManagerSnapshot, String> {
    let next_seq = self.current_seq.fetch_add(1, Ordering::SeqCst) + 1;
    let view_instance_id = self.view_counter.fetch_add(1, Ordering::SeqCst);

    let (account_record, app_data_dir) = {
      let mut locked = self.inner.lock().await;
      if !locked.conflicts.is_empty() {
        return Err("存在 UUID 归属冲突，已停留在管理页".to_string());
      }
      if !get_provider(key.provider_id).info.enabled {
        return Err(format!("{} 尚未开放应用内嵌", get_provider(key.provider_id).info.name));
      }
      if locked.store.pending_cleanup.contains(&key) {
        self.teardown_current_slot(app, next_seq, &mut locked).await;
        locked.notice = Some("该账号正在清理本地资料，请稍后重试或重新创建".to_string());
        return Ok(Self::snapshot_from_locked(&locked));
      }
      let Some(acc) = locked
        .store
        .accounts
        .iter()
        .find(|a| a.provider_id == key.provider_id && a.uuid == key.uuid)
        .cloned()
      else {
        self.teardown_current_slot(app, next_seq, &mut locked).await;
        locked.notice = Some("账号归属核对失败，已回到管理页".to_string());
        return Ok(Self::snapshot_from_locked(&locked));
      };

      if let Some(slot) = &locked.active_slot {
        if slot.committed && slot.account_key == key && !is_cold_start {
          #[cfg(desktop)]
          return Ok(Self::snapshot_from_locked(&locked));
        }
      }

      locked.selected_provider_id = key.provider_id;
      locked.notice = None;
      self.teardown_current_slot(app, next_seq, &mut locked).await;
      (acc, locked.app_data_dir.clone())
    };

    #[cfg(desktop)]
    {
      self
        .open_desktop_session(
          app,
          account_record,
          app_data_dir,
          next_seq,
          view_instance_id,
          is_cold_start,
        )
        .await
    }

    #[cfg(target_os = "android")]
    {
      let _ = app_data_dir;
      self
        .open_android_session(app, account_record, next_seq, view_instance_id, is_cold_start)
        .await
    }
  }

  #[cfg(desktop)]
  async fn open_desktop_session(
    self: &Arc<Self>,
    app: &AppHandle,
    account: AccountRecord,
    app_data_dir: PathBuf,
    expected_seq: u64,
    view_instance_id: u64,
    is_cold_start: bool,
  ) -> Result<ManagerSnapshot, String> {
    let parsed_uuid = Uuid::parse_str(&account.uuid).map_err(|e| format!("非法 UUID: {e}"))?;
    let profile_dir = app_data_dir.join("profiles").join(&account.uuid);

    #[cfg(windows)]
    if is_cold_start && !profile_dir.exists() {
      let mut locked = self.inner.lock().await;
      locked.notice = Some("上次已提交账号的 Windows WebView2 资料目录缺失，已停留在管理页".to_string());
      return Ok(Self::snapshot_from_locked(&locked));
    }
    #[cfg(not(windows))]
    let _ = is_cold_start;

    #[cfg(windows)]
    std::fs::create_dir_all(&profile_dir).map_err(|e| format!("创建资料目录失败: {e}"))?;

    let main_win = app
      .get_window("main")
      .ok_or_else(|| "主窗口不存在".to_string())?;

    let webview_label = format!("account-{view_instance_id}");
    let allow_blank = Arc::new(AtomicBool::new(true));
    let key = AccountKey {
      provider_id: account.provider_id,
      uuid: account.uuid.clone(),
    };

    {
      let mut locked = self.inner.lock().await;
      if self.current_seq.load(Ordering::SeqCst) != expected_seq {
        return Ok(Self::snapshot_from_locked(&locked));
      }
      locked.active_slot = Some(ActiveSessionSlot {
        account_key: key.clone(),
        view_instance_id,
        switch_seq: expected_seq,
        committed: false,
        webview_label: webview_label.clone(),
        popup_label: None,
      });
    }

    let seq_ref_nav = Arc::clone(&self.current_seq);
    let mgr_for_nav = Arc::clone(self);
    let app_for_nav = app.clone();
    let allow_blank_nav = Arc::clone(&allow_blank);
    let provider_id = account.provider_id;
    let key_for_nav = key.clone();

    let seq_ref_popup = Arc::clone(&self.current_seq);
    let mgr_for_popup = Arc::clone(self);
    let app_for_popup = app.clone();
    let key_for_popup = key.clone();
    let popup_counter = Arc::new(AtomicU64::new(1));

    let seq_ref_load = Arc::clone(&self.current_seq);
    let mgr_for_load = Arc::clone(self);
    let app_for_load = app.clone();
    let key_for_load = key.clone();

    let mut builder = tauri::webview::WebviewBuilder::new(
      &webview_label,
      tauri::WebviewUrl::External("about:blank".parse().expect("valid blank url")),
    )
    .focused(false)
    .on_navigation(move |url| {
      if seq_ref_nav.load(Ordering::SeqCst) != expected_seq {
        return false;
      }
      let can_blank = allow_blank_nav.load(Ordering::SeqCst);
      match classify_top_level_url(provider_id, url, can_blank) {
        NavigationDecision::AllowBlank => true,
        NavigationDecision::AllowHttps => {
          allow_blank_nav.store(false, Ordering::SeqCst);
          true
        }
        NavigationDecision::ExternalGoogleOAuth => {
          let mgr_ext = Arc::clone(&mgr_for_nav);
          let app_ext = app_for_nav.clone();
          let key_ext = key_for_nav.clone();
          tauri::async_runtime::spawn(async move {
            mgr_ext
              .notify_external_auth_policy(&app_ext, key_ext, expected_seq, view_instance_id)
              .await;
          });
          false
        }
        NavigationDecision::Deny => false,
      }
    })
    .on_new_window(move |url, features| {
      if seq_ref_popup.load(Ordering::SeqCst) != expected_seq {
        return tauri::webview::NewWindowResponse::Deny;
      }
      let decision = classify_top_level_url(provider_id, &url, true);
      match decision {
        NavigationDecision::ExternalGoogleOAuth => {
          let mgr_ext = Arc::clone(&mgr_for_popup);
          let app_ext = app_for_popup.clone();
          let key_ext = key_for_popup.clone();
          tauri::async_runtime::spawn(async move {
            mgr_ext
              .notify_external_auth_policy(&app_ext, key_ext, expected_seq, view_instance_id)
              .await;
          });
          return tauri::webview::NewWindowResponse::Deny;
        }
        NavigationDecision::Deny => {
          return tauri::webview::NewWindowResponse::Deny;
        }
        NavigationDecision::AllowBlank | NavigationDecision::AllowHttps => {}
      }

      let popup_idx = popup_counter.fetch_add(1, Ordering::SeqCst);
      let popup_label = format!("auth-popup-{view_instance_id}-{popup_idx}");
      let popup_label_for_close = popup_label.clone();
      let popup_label_for_slot = popup_label.clone();

      let seq_popup_nav = Arc::clone(&seq_ref_popup);
      let app_popup_nav = app_for_popup.clone();
      let mgr_popup_nav = Arc::clone(&mgr_for_popup);
      let key_popup_nav = key_for_popup.clone();

      let popup_title = url
        .host_str()
        .map(|h| format!("登录认证 · {h}"))
        .unwrap_or_else(|| "登录认证".to_string());

      let popup_builder = tauri::WebviewWindowBuilder::new(
        &app_for_popup,
        &popup_label,
        tauri::WebviewUrl::External("about:blank".parse().expect("valid blank url")),
      )
      .window_features(features)
      .title(&popup_title)
      .on_navigation(move |nav_url| {
        if seq_popup_nav.load(Ordering::SeqCst) != expected_seq {
          if let Some(pw) = app_popup_nav.get_webview_window(&popup_label_for_close) {
            let _ = pw.close();
          }
          return false;
        }
        match classify_top_level_url(provider_id, nav_url, true) {
          NavigationDecision::AllowBlank => true,
          NavigationDecision::AllowHttps => {
            if let Some(host) = nav_url.host_str() {
              if let Some(pw) = app_popup_nav.get_webview_window(&popup_label_for_close) {
                let _ = pw.set_title(&format!("登录认证 · {host}"));
              }
            }
            true
          }
          NavigationDecision::ExternalGoogleOAuth => {
            if let Some(pw) = app_popup_nav.get_webview_window(&popup_label_for_close) {
              let _ = pw.close();
            }
            let mgr_ext = Arc::clone(&mgr_popup_nav);
            let app_ext = app_popup_nav.clone();
            let key_ext = key_popup_nav.clone();
            tauri::async_runtime::spawn(async move {
              mgr_ext
                .notify_external_auth_policy(&app_ext, key_ext, expected_seq, view_instance_id)
                .await;
            });
            false
          }
          NavigationDecision::Deny => false,
        }
      });

      match popup_builder.build() {
        Ok(popup_window) => {
          let mgr_slot = Arc::clone(&mgr_for_popup);
          let app_slot = app_for_popup.clone();
          tauri::async_runtime::spawn(async move {
            mgr_slot
              .register_desktop_popup(&app_slot, expected_seq, view_instance_id, popup_label_for_slot)
              .await;
          });
          tauri::webview::NewWindowResponse::Create {
            window: popup_window,
          }
        }
        Err(_) => tauri::webview::NewWindowResponse::Deny,
      }
    })
    .on_page_load(move |_wv, payload| {
      if payload.event() != tauri::webview::PageLoadEvent::Finished {
        return;
      }
      if payload.url().as_str() == "about:blank" {
        return;
      }
      if seq_ref_load.load(Ordering::SeqCst) != expected_seq {
        return;
      }
      let loaded_url = payload.url().clone();
      let mgr_commit = Arc::clone(&mgr_for_load);
      let app_commit = app_for_load.clone();
      let key_commit = key_for_load.clone();
      tauri::async_runtime::spawn(async move {
        mgr_commit
          .commit_session(&app_commit, key_commit, view_instance_id, expected_seq, loaded_url)
          .await;
      });
    });

    #[cfg(target_os = "macos")]
    {
      builder = builder
        .data_store_identifier(*parsed_uuid.as_bytes())
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15");
    }

    #[cfg(not(target_os = "macos"))]
    {
      builder = builder.data_directory(profile_dir.clone());
    }

    let created_wv = match main_win.add_child(
      builder,
      tauri::LogicalPosition::new(0.0, 0.0),
      tauri::LogicalSize::new(1.0, 1.0),
    ) {
      Ok(wv) => wv,
      Err(err) => {
        let mut locked = self.inner.lock().await;
        if self.current_seq.load(Ordering::SeqCst) == expected_seq {
          locked.active_slot = None;
          locked.notice = Some(format!("创建独立账号视图失败: {err}"));
          Self::apply_desktop_layout_locked(app, &locked);
        }
        return Ok(Self::snapshot_from_locked(&locked));
      }
    };
    let _ = created_wv.hide();

    if let Err(verify_err) =
      platform::verify_desktop_profile_binding(&created_wv, parsed_uuid, &profile_dir).await
    {
      let _ = created_wv.close();
      let mut locked = self.inner.lock().await;
      if self.current_seq.load(Ordering::SeqCst) == expected_seq {
        locked.active_slot = None;
        locked.notice = Some(verify_err);
        Self::apply_desktop_layout_locked(app, &locked);
      }
      return Ok(Self::snapshot_from_locked(&locked));
    }

    if self.current_seq.load(Ordering::SeqCst) != expected_seq {
      let _ = created_wv.close();
      return Ok(self.get_snapshot().await);
    }

    let entry_url: Url = get_provider(account.provider_id)
      .info
      .entry_url
      .parse()
      .map_err(|e| format!("服务入口地址错误: {e}"))?;

    if let Err(nav_err) = created_wv.navigate(entry_url) {
      let _ = created_wv.close();
      let mut locked = self.inner.lock().await;
      if self.current_seq.load(Ordering::SeqCst) == expected_seq {
        locked.active_slot = None;
        locked.notice = Some(format!("导航到服务入口失败: {nav_err}"));
        Self::apply_desktop_layout_locked(app, &locked);
      }
      return Ok(Self::snapshot_from_locked(&locked));
    }

    Ok(self.get_snapshot().await)
  }

  #[cfg(desktop)]
  async fn register_desktop_popup(
    &self,
    app: &AppHandle,
    expected_seq: u64,
    view_instance_id: u64,
    popup_label: String,
  ) {
    let mut locked = self.inner.lock().await;
    if self.current_seq.load(Ordering::SeqCst) != expected_seq {
      if let Some(pw) = app.get_webview_window(&popup_label) {
        let _ = pw.close();
      }
      return;
    }
    let Some(slot) = &mut locked.active_slot else {
      if let Some(pw) = app.get_webview_window(&popup_label) {
        let _ = pw.close();
      }
      return;
    };
    if slot.switch_seq != expected_seq || slot.view_instance_id != view_instance_id {
      if let Some(pw) = app.get_webview_window(&popup_label) {
        let _ = pw.close();
      }
      return;
    }
    if let Some(prev_popup) = slot.popup_label.replace(popup_label) {
      if let Some(pw) = app.get_webview_window(&prev_popup) {
        let _ = pw.close();
      }
    }
  }

  #[cfg(target_os = "android")]
  async fn open_android_session(
    self: &Arc<Self>,
    app: &AppHandle,
    account: AccountRecord,
    expected_seq: u64,
    view_instance_id: u64,
    is_cold_start: bool,
  ) -> Result<ManagerSnapshot, String> {
    let caps = match crate::platform::android::check_capabilities(app).await {
      Ok(c) => c,
      Err(err) => {
        let mut locked = self.inner.lock().await;
        locked.notice = Some(format!("检测 Android WebView 多资料能力失败: {err}"));
        return Ok(Self::snapshot_from_locked(&locked));
      }
    };

    if !caps.multi_profile_supported {
      let mut locked = self.inner.lock().await;
      locked.notice = Some(
        "当前设备系统 WebView 不支持 MULTI_PROFILE 多资料隔离，请先更新 Android System WebView 后重试"
          .to_string(),
      );
      return Ok(Self::snapshot_from_locked(&locked));
    }

    if is_cold_start && !caps.profile_names.iter().any(|n| n == &account.uuid) {
      let mut locked = self.inner.lock().await;
      locked.notice = Some("上次已提交账号的系统 Profile 已丢失，已停留在管理页".to_string());
      return Ok(Self::snapshot_from_locked(&locked));
    }

    let key = AccountKey {
      provider_id: account.provider_id,
      uuid: account.uuid.clone(),
    };

    {
      let mut locked = self.inner.lock().await;
      if self.current_seq.load(Ordering::SeqCst) != expected_seq {
        return Ok(Self::snapshot_from_locked(&locked));
      }
      locked.active_slot = Some(ActiveSessionSlot {
        account_key: key,
        view_instance_id,
        switch_seq: expected_seq,
        committed: false,
      });
    }

    let spec = get_provider(account.provider_id);
    let payload = crate::platform::android::OpenAndroidAccountPayload {
      provider_id: account.provider_id.as_str().to_string(),
      provider_name: spec.info.short_name.to_string(),
      uuid: account.uuid.clone(),
      alias: account.alias.clone(),
      entry_url: spec.info.entry_url.to_string(),
      allowed_hosts: spec.allowed_hosts.iter().map(|s| (*s).to_string()).collect(),
      switch_seq: expected_seq,
      view_instance_id,
      is_cold_start,
    };

    if let Err(err) = crate::platform::android::open_account_session(app, payload).await {
      let mut locked = self.inner.lock().await;
      if self.current_seq.load(Ordering::SeqCst) == expected_seq {
        locked.active_slot = None;
        locked.notice = Some(format!("打开 Android 独立会话页面失败: {err}"));
      }
      return Ok(Self::snapshot_from_locked(&locked));
    }

    Ok(self.get_snapshot().await)
  }

  #[cfg(target_os = "android")]
  async fn handle_android_event(
    self: &Arc<Self>,
    app: &AppHandle,
    event: crate::platform::android::AndroidSessionEvent,
  ) {
    use crate::platform::android::AndroidSessionEvent;
    match event {
      AndroidSessionEvent::PageCommitVisible {
        provider_id,
        uuid,
        switch_seq,
        view_instance_id,
        url,
      } => {
        let Some(pid) = ProviderId::parse(&provider_id) else {
          return;
        };
        let Some(norm_uuid) = normalize_uuid(&uuid) else {
          return;
        };
        let Ok(parsed_url) = Url::parse(&url) else {
          return;
        };
        self
          .commit_session(
            app,
            AccountKey {
              provider_id: pid,
              uuid: norm_uuid,
            },
            view_instance_id,
            switch_seq,
            parsed_url,
          )
          .await;
      }
      AndroidSessionEvent::SessionFailed {
        switch_seq,
        view_instance_id,
        reason,
      } => {
        let snap = {
          let mut locked = self.inner.lock().await;
          if self.current_seq.load(Ordering::SeqCst) != switch_seq {
            return;
          }
          let matches = locked
            .active_slot
            .as_ref()
            .map(|s| s.switch_seq == switch_seq && s.view_instance_id == view_instance_id)
            .unwrap_or(false);
          if !matches {
            return;
          }
          locked.active_slot = None;
          locked.notice = Some(reason);
          Self::snapshot_from_locked(&locked)
        };
        self.emit_snapshot(app, &snap);
      }
      AndroidSessionEvent::ActivityClosed {
        switch_seq,
        view_instance_id,
      } => {
        let snap = {
          let mut locked = self.inner.lock().await;
          let matches = locked
            .active_slot
            .as_ref()
            .map(|s| s.switch_seq == switch_seq && s.view_instance_id == view_instance_id)
            .unwrap_or(false);
          if !matches {
            return;
          }
          locked.active_slot = None;
          locked.pending_external_auth = None;
          Self::snapshot_from_locked(&locked)
        };
        self.emit_snapshot(app, &snap);
      }
      AndroidSessionEvent::ExternalAuthUnavailable {
        switch_seq,
        view_instance_id,
        reason,
      } => {
        let snap = {
          let mut locked = self.inner.lock().await;
          let matches = locked
            .active_slot
            .as_ref()
            .map(|s| s.switch_seq == switch_seq && s.view_instance_id == view_instance_id)
            .unwrap_or(false);
          if !matches {
            return;
          }
          locked.pending_external_auth = None;
          locked.notice = Some(reason);
          Self::snapshot_from_locked(&locked)
        };
        self.emit_snapshot(app, &snap);
      }
      AndroidSessionEvent::RecreateRequested { previous_switch_seq } => {
        let fallback = {
          let mut locked = self.inner.lock().await;
          if self.current_seq.load(Ordering::SeqCst) == previous_switch_seq {
            locked.active_slot = None;
          }
          locked.store.last_committed.clone()
        };
        if let Some(committed_key) = fallback {
          let _ = self.switch_account_internal(app, committed_key, true).await;
        } else {
          let snap = self.get_snapshot().await;
          self.emit_snapshot(app, &snap);
        }
      }
    }
  }

  async fn notify_external_auth_policy(
    &self,
    app: &AppHandle,
    key: AccountKey,
    expected_seq: u64,
    view_instance_id: u64,
  ) {
    let snap_opt = {
      let mut locked = self.inner.lock().await;
      if self.current_seq.load(Ordering::SeqCst) != expected_seq {
        return;
      }
      let matches = locked
        .active_slot
        .as_ref()
        .map(|s| {
          s.account_key == key
            && s.switch_seq == expected_seq
            && s.view_instance_id == view_instance_id
        })
        .unwrap_or(false);
      if !matches {
        return;
      }
      let entry_ok = Url::parse(get_provider(key.provider_id).info.entry_url)
        .map(|u| is_verified_callback_origin(key.provider_id, &u))
        .unwrap_or(false);
      locked.pending_external_auth = Some(PendingExternalAuth {
        account_key: key.clone(),
        switch_seq: expected_seq,
        nonce: format!("{}-{}", key.provider_id.as_str(), Uuid::new_v4().simple()),
      });
      if !entry_ok || locked.pending_external_auth.is_some() {
        locked.pending_external_auth = None;
      }
      locked.notice = Some(
        "Google OAuth 按政策禁止内嵌 WebView，且系统浏览器回跳暂无法绑定到当前独立浏览资料，请使用邮箱、手机号或已验收方式登录"
          .to_string(),
      );
      Some(Self::snapshot_from_locked(&locked))
    };

    if let Some(snap) = snap_opt {
      self.emit_snapshot(app, &snap);
    }
  }

  async fn commit_session(
    &self,
    app: &AppHandle,
    key: AccountKey,
    view_instance_id: u64,
    expected_seq: u64,
    committed_url: Url,
  ) {
    if self.current_seq.load(Ordering::SeqCst) != expected_seq {
      return;
    }

    if classify_top_level_url(key.provider_id, &committed_url, false) != NavigationDecision::AllowHttps {
      return;
    }

    #[cfg(desktop)]
    {
      let check_params = {
        let locked = self.inner.lock().await;
        locked.active_slot.as_ref().and_then(|s| {
          if s.account_key == key
            && s.view_instance_id == view_instance_id
            && s.switch_seq == expected_seq
          {
            Some((
              s.webview_label.clone(),
              locked.app_data_dir.join("profiles").join(&key.uuid),
            ))
          } else {
            None
          }
        })
      };

      let Some((wv_label, expected_dir)) = check_params else {
        return;
      };
      let Ok(parsed_uuid) = Uuid::parse_str(&key.uuid) else {
        return;
      };
      if let Some(wv) = app.get_webview(&wv_label) {
        if let Err(err) =
          platform::verify_desktop_profile_binding(&wv, parsed_uuid, &expected_dir).await
        {
          let snap = {
            let mut locked = self.inner.lock().await;
            if self.current_seq.load(Ordering::SeqCst) == expected_seq {
              self.teardown_current_slot(app, expected_seq, &mut locked).await;
              locked.notice = Some(err);
            }
            Self::snapshot_from_locked(&locked)
          };
          self.emit_snapshot(app, &snap);
          return;
        }
      } else {
        return;
      }
    }

    let snap_opt = {
      let mut locked = self.inner.lock().await;
      if self.current_seq.load(Ordering::SeqCst) != expected_seq {
        return;
      }
      if !locked.conflicts.is_empty() || locked.store.pending_cleanup.contains(&key) {
        self.teardown_current_slot(app, expected_seq, &mut locked).await;
        return;
      }
      let Some(acc) = locked
        .store
        .accounts
        .iter()
        .find(|a| a.provider_id == key.provider_id && a.uuid == key.uuid)
        .cloned()
      else {
        self.teardown_current_slot(app, expected_seq, &mut locked).await;
        return;
      };

      let slot_matches = locked
        .active_slot
        .as_ref()
        .map(|s| {
          s.account_key == key
            && s.view_instance_id == view_instance_id
            && s.switch_seq == expected_seq
        })
        .unwrap_or(false);
      if !slot_matches {
        return;
      }

      let prev_last = locked.store.last_committed.clone();
      locked.store.last_committed = Some(key.clone());
      if let Err(err) = save_store_atomic(&locked.store_path, &locked.store) {
        locked.store.last_committed = prev_last;
        self.teardown_current_slot(app, expected_seq, &mut locked).await;
        locked.notice = Some(format!("提交账号记录写盘失败，已回退管理页: {err}"));
        Some(Self::snapshot_from_locked(&locked))
      } else {
        if let Some(slot) = &mut locked.active_slot {
          slot.committed = true;
        }
        let title = format!(
          "{} · {}",
          get_provider(key.provider_id).info.short_name,
          acc.alias
        );
        #[cfg(desktop)]
        {
          if let Some(main_win) = app.get_window("main") {
            let _ = main_win.set_title(&title);
          }
          Self::apply_desktop_layout_locked(app, &locked);
        }
        #[cfg(target_os = "android")]
        {
          let _ = crate::platform::android::update_account_title(app, expected_seq, &title).await;
        }
        Some(Self::snapshot_from_locked(&locked))
      }
    };

    if let Some(snap) = snap_opt {
      self.emit_snapshot(app, &snap);
    }
  }
}
