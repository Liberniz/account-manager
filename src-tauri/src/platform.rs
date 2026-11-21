use std::path::Path;
use uuid::Uuid;

pub fn current_platform_name() -> &'static str {
  "macos"
}

pub fn open_external_browser(url: &str) -> Result<(), String> {
  open::that_detached(url).map_err(|e| format!("打开系统浏览器失败: {e}"))
}

pub fn verify_desktop_profile_binding(
  webview: &tauri::Webview,
  expected_uuid: Uuid,
  expected_dir: &Path,
) -> impl std::future::Future<Output = Result<(), String>> + Send {
  let _ = expected_dir;
  let (tx, rx) = tokio::sync::oneshot::channel();
  let res = webview.with_webview(move |platform_wv| unsafe {
    let wk: &objc2_web_kit::WKWebView = &*platform_wv.inner().cast();
    let store = wk.configuration().websiteDataStore();
    let check = match store.identifier() {
      Some(ns_uuid) => {
        let actual = ns_uuid.UUIDString().to_string();
        let expected = expected_uuid.hyphenated().to_string();
        if actual.eq_ignore_ascii_case(&expected) {
          Ok(())
        } else {
          Err(format!(
            "WKWebsiteDataStore 标识不匹配（期望 {expected}，实际 {actual}）"
          ))
        }
      }
      None => Err("WKWebsiteDataStore 未绑定独立 UUID（落入默认资料），已阻止加载".to_string()),
    };
    let _ = tx.send(check);
  });

  async move {
    res.map_err(|e| format!("访问 macOS WebView 失败: {e}"))?;
    rx
      .await
      .map_err(|_| "核对 macOS WKWebsiteDataStore 超时或中断".to_string())?
  }
}

pub async fn delete_desktop_profile(
  app: &tauri::AppHandle,
  app_data_dir: &Path,
  uuid_str: &str,
) -> Result<(), String> {
  let parsed = Uuid::parse_str(uuid_str).map_err(|e| format!("非法 UUID: {e}"))?;
  let _ = app_data_dir;
  let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
  let uuid_formatted = parsed.hyphenated().to_string();
  let tx_cell = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));

  app
    .run_on_main_thread(move || {
      use objc2::AnyThread;
      use objc2_foundation::{NSError, NSString, NSUUID};
      use objc2_web_kit::WKWebsiteDataStore;

      let ns_str = NSString::from_str(&uuid_formatted);
      let Some(ns_uuid) = NSUUID::initWithUUIDString(NSUUID::alloc(), &ns_str) else {
        if let Some(sender) = tx_cell.lock().unwrap().take() {
          let _ = sender.send(Err("构造 NSUUID 失败".to_string()));
        }
        return;
      };

      let Some(mtm) = objc2::MainThreadMarker::new() else {
        if let Some(sender) = tx_cell.lock().unwrap().take() {
          let _ = sender.send(Err("当前不在 macOS 主线程".to_string()));
        }
        return;
      };

      let tx_inner = tx_cell.clone();
      let block = block2::RcBlock::new(move |err: *mut NSError| {
        let outcome = if err.is_null() {
          Ok(())
        } else {
          let msg = unsafe { (&*err).localizedDescription().to_string() };
          if msg.to_ascii_lowercase().contains("not exist")
            || msg.to_ascii_lowercase().contains("not found")
          {
            Ok(())
          } else {
            Err(format!("移除 WKWebsiteDataStore 失败: {msg}"))
          }
        };
        if let Some(sender) = tx_inner.lock().unwrap().take() {
          let _ = sender.send(outcome);
        }
      });

      unsafe {
        WKWebsiteDataStore::removeDataStoreForIdentifier_completionHandler(&ns_uuid, &block, mtm);
      }
    })
    .map_err(|e| format!("调度主线程清理 WKWebsiteDataStore 失败: {e}"))?;

  rx
    .await
    .map_err(|_| "等待 WKWebsiteDataStore 清理完成中断".to_string())?
}

/// 读取 macOS 系统代理设置（scutil --proxy），拼成代理 URL。
/// 优先 HTTP/HTTPS，其次 SOCKS；系统未启用代理时返回 None。
pub fn resolve_system_proxy() -> Option<String> {
  let output = std::process::Command::new("scutil")
    .arg("--proxy")
    .output()
    .ok()?;
  if !output.status.success() {
    return None;
  }
  let text = String::from_utf8_lossy(&output.stdout);
  let get = |key: &str| -> Option<String> {
    text.lines().find_map(|line| {
      let line = line.trim();
      let (k, v) = line.split_once(':')?;
      if k.trim() == key {
        Some(v.trim().to_string())
      } else {
        None
      }
    })
  };
  let enabled = |key: &str| get(key).map(|v| v == "1").unwrap_or(false);

  if enabled("HTTPEnable") || enabled("HTTPSEnable") {
    let (host, port) = if enabled("HTTPEnable") {
      (get("HTTPProxy"), get("HTTPPort"))
    } else {
      (get("HTTPSProxy"), get("HTTPSPort"))
    };
    if let (Some(host), Some(port)) = (host, port) {
      if !host.is_empty() && !port.is_empty() {
        return Some(format!("http://{host}:{port}"));
      }
    }
  }
  if enabled("SOCKSEnable") {
    if let (Some(host), Some(port)) = (get("SOCKSProxy"), get("SOCKSPort")) {
      if !host.is_empty() && !port.is_empty() {
        return Some(format!("socks5://{host}:{port}"));
      }
    }
  }
  None
}
