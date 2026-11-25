use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};
use url::Url;

/// 服务商 ID：内置服务为 "muse" / "glados"，用户自定义服务为 "custom:<defId>"。
/// 序列化为透明字符串，老配置文件格式不变。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ProviderId(pub String);

impl ProviderId {
  pub fn muse() -> Self {
    Self("muse".to_string())
  }

  pub fn glados() -> Self {
    Self("glados".to_string())
  }

  pub fn custom(def_id: &str) -> Self {
    Self(format!("custom:{def_id}"))
  }

  pub fn as_str(&self) -> &str {
    &self.0
  }

  pub fn is_custom(&self) -> bool {
    self.0.starts_with("custom:")
  }

  pub fn custom_def_id(&self) -> Option<&str> {
    self.0.strip_prefix("custom:")
  }

  pub fn parse(value: &str) -> Option<Self> {
    let v = value.trim().to_ascii_lowercase();
    match v.as_str() {
      "muse" | "glados" => Some(Self(v)),
      _ if v.starts_with("custom:") && v.len() > "custom:".len() => Some(Self(v)),
      _ => None,
    }
  }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
  pub id: ProviderId,
  pub name: String,
  pub short_name: String,
  pub enabled: bool,
  pub status_text: String,
  pub entry_url: String,
  pub homepage_url: String,
  pub callback_origins: Vec<String>,
  pub verified_methods: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct ProviderSpec {
  pub info: ProviderInfo,
  pub allowed_hosts: Vec<String>,
}

fn builtin_providers() -> Vec<ProviderSpec> {
  vec![
    ProviderSpec {
      info: ProviderInfo {
        id: ProviderId::muse(),
        name: "Muse · Meta".to_string(),
        short_name: "Muse".to_string(),
        enabled: true,
        status_text: "已启用".to_string(),
        entry_url: "https://muse.ai/".to_string(),
        homepage_url: "https://muse.ai/".to_string(),
        callback_origins: vec![
          "https://muse.ai".to_string(),
          "https://www.muse.ai".to_string(),
        ],
        verified_methods: vec!["email".to_string(), "phone".to_string()],
      },
      allowed_hosts: [
        "muse.ai",
        "meta.com",
        "meta.ai",
        "facebook.com",
        "instagram.com",
        "fb.com",
        "appleid.apple.com",
        "idmsa.apple.com",
        // Muse Space 预览域（上游 Issue #4 白屏修复）：预览 iframe/弹窗
        // 加载这些域名被拦会导致 Space 白屏，子域匹配自动覆盖 *.
        "metaaiusercontent.com",
        "ecto1usercontent.com",
        "meta-agents-apps.workers.dev",
      ]
      .iter()
      .map(|s| s.to_string())
      .collect(),
    },
    ProviderSpec {
      info: ProviderInfo {
        id: ProviderId::glados(),
        name: "GLaDOS".to_string(),
        short_name: "GLaDOS".to_string(),
        enabled: true,
        status_text: "已启用".to_string(),
        entry_url: "https://glados.cloud/console".to_string(),
        homepage_url: "https://glados.cloud".to_string(),
        callback_origins: vec![
          "https://glados.cloud".to_string(),
          "https://glados.one".to_string(),
          "https://glados.rocks".to_string(),
          "https://glados-facility.com".to_string(),
          "https://railgun.info".to_string(),
        ],
        verified_methods: vec!["cookie".to_string()],
      },
      // GLaDOS 系站点（会话按域名隔离，账号各自记录登录域名）。
      allowed_hosts: [
        "glados.cloud",
        "glados.one",
        "glados.rocks",
        "glados-facility.com",
        "railgun.info",
      ]
      .iter()
      .map(|s| s.to_string())
      .collect(),
    },
  ]
}

fn builtins() -> &'static Vec<ProviderSpec> {
  static BUILTINS: OnceLock<Vec<ProviderSpec>> = OnceLock::new();
  BUILTINS.get_or_init(builtin_providers)
}

/// 用户自定义服务注册表（def_id → spec），由 SessionManager 启动时灌入、
/// 增删自定义服务时同步更新。
fn custom_registry() -> &'static RwLock<HashMap<String, ProviderSpec>> {
  static REGISTRY: OnceLock<RwLock<HashMap<String, ProviderSpec>>> = OnceLock::new();
  REGISTRY.get_or_init(|| RwLock::new(HashMap::new()))
}

pub fn make_custom_spec(def_id: &str, name: &str, entry_url: &str) -> Option<ProviderSpec> {
  let parsed = Url::parse(entry_url).ok()?;
  let host = parsed.host_str()?.to_string();
  let origin = parsed.origin().ascii_serialization();
  Some(ProviderSpec {
    info: ProviderInfo {
      id: ProviderId::custom(def_id),
      name: name.to_string(),
      short_name: name.to_string(),
      enabled: true,
      status_text: "已启用".to_string(),
      entry_url: entry_url.to_string(),
      homepage_url: entry_url.to_string(),
      callback_origins: vec![origin],
      verified_methods: vec!["web".to_string()],
    },
    allowed_hosts: vec![host],
  })
}

pub fn register_custom_providers(specs: Vec<ProviderSpec>) {
  let mut reg = custom_registry().write().unwrap();
  reg.clear();
  for spec in specs {
    if let Some(def_id) = spec.info.id.custom_def_id() {
      reg.insert(def_id.to_string(), spec);
    }
  }
}

pub fn get_provider(id: &ProviderId) -> ProviderSpec {
  if let Some(found) = builtins().iter().find(|p| &p.info.id == id) {
    return found.clone();
  }
  if let Some(def_id) = id.custom_def_id() {
    if let Some(found) = custom_registry().read().unwrap().get(def_id) {
      return found.clone();
    }
  }
  // 未知/已删除的服务：返回禁用占位，避免任何调用点 panic。
  ProviderSpec {
    info: ProviderInfo {
      id: id.clone(),
      name: "已删除的服务".to_string(),
      short_name: "已删除".to_string(),
      enabled: false,
      status_text: "已下线".to_string(),
      entry_url: "https://example.com/".to_string(),
      homepage_url: "https://example.com/".to_string(),
      callback_origins: vec![],
      verified_methods: vec![],
    },
    allowed_hosts: vec![],
  }
}

pub fn all_provider_infos() -> Vec<ProviderInfo> {
  let mut infos: Vec<ProviderInfo> = builtins().iter().map(|p| p.info.clone()).collect();
  let mut customs: Vec<ProviderInfo> = custom_registry()
    .read()
    .unwrap()
    .values()
    .map(|p| p.info.clone())
    .collect();
  customs.sort_by(|a, b| a.name.cmp(&b.name));
  infos.extend(customs);
  infos
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavigationDecision {
  AllowBlank,
  AllowHttps,
  ExternalGoogleOAuth,
  Deny,
}

pub fn host_matches(host: &str, domain: &str) -> bool {
  if host.eq_ignore_ascii_case(domain) {
    return true;
  }
  let suffix = format!(".{}", domain.to_ascii_lowercase());
  host.to_ascii_lowercase().ends_with(&suffix)
}

const EMBEDDED_WIDGET_HOSTS: &[&str] = &[
  "challenges.cloudflare.com",
  "turnstile.cloudflare.com",
  "hcaptcha.com",
  "recaptcha.net",
  "gstatic.com",
  "arkoselabs.com",
  "funcaptcha.com",
  "friendlycaptcha.com",
  "geetest.com",
  "captcha-delivery.com",
  "firebaseapp.com",
  "stripe.com",
  "stripecdn.com",
];

fn is_embedded_widget_url(url: &Url, host: &str) -> bool {
  if EMBEDDED_WIDGET_HOSTS.iter().any(|allowed| host_matches(host, allowed)) {
    return true;
  }
  (host.eq_ignore_ascii_case("www.google.com") || host.eq_ignore_ascii_case("google.com"))
    && url.path().starts_with("/recaptcha")
}

pub fn classify_top_level_url(
  provider_id: &ProviderId,
  url: &Url,
  allow_blank: bool,
) -> NavigationDecision {
  let raw = url.as_str();
  if raw == "about:srcdoc" || raw.starts_with("blob:https://") || raw.starts_with("blob:null") {
    return NavigationDecision::AllowBlank;
  }
  if allow_blank && raw == "about:blank" {
    return NavigationDecision::AllowBlank;
  }
  if url.scheme() != "https" {
    return NavigationDecision::Deny;
  }
  let Some(host) = url.host_str() else {
    return NavigationDecision::Deny;
  };
  if host_matches(host, "accounts.google.com") {
    return NavigationDecision::ExternalGoogleOAuth;
  }
  let spec = get_provider(provider_id);
  if spec
    .allowed_hosts
    .iter()
    .any(|allowed| host_matches(host, allowed))
    || is_embedded_widget_url(url, host)
  {
    NavigationDecision::AllowHttps
  } else {
    NavigationDecision::Deny
  }
}

pub fn is_verified_callback_origin(provider_id: &ProviderId, url: &Url) -> bool {
  if url.scheme() != "https" {
    return false;
  }
  let origin = url.origin().ascii_serialization();
  get_provider(provider_id)
    .info
    .callback_origins
    .iter()
    .any(|allowed| allowed.eq_ignore_ascii_case(&origin))
}
