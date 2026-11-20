use serde::{Deserialize, Serialize};
use url::Url;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderId {
  Muse,
  Hark,
}

impl ProviderId {
  pub fn as_str(self) -> &'static str {
    match self {
      ProviderId::Muse => "muse",
      ProviderId::Hark => "hark",
    }
  }

  pub fn parse(value: &str) -> Option<Self> {
    match value.trim().to_ascii_lowercase().as_str() {
      "muse" => Some(ProviderId::Muse),
      "hark" => Some(ProviderId::Hark),
      _ => None,
    }
  }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
  pub id: ProviderId,
  pub name: &'static str,
  pub short_name: &'static str,
  pub enabled: bool,
  pub status_text: &'static str,
  pub entry_url: &'static str,
  pub homepage_url: &'static str,
  pub callback_origins: &'static [&'static str],
  pub verified_methods: &'static [&'static str],
}

pub struct ProviderSpec {
  pub info: ProviderInfo,
  pub allowed_hosts: &'static [&'static str],
}

pub const PROVIDERS: &[ProviderSpec] = &[
  ProviderSpec {
    info: ProviderInfo {
      id: ProviderId::Muse,
      name: "Muse · Meta",
      short_name: "Muse",
      enabled: true,
      status_text: "已启用",
      entry_url: "https://muse.ai/",
      homepage_url: "https://muse.ai/",
      callback_origins: &["https://muse.ai", "https://www.muse.ai"],
      verified_methods: &["email", "phone"],
    },
    allowed_hosts: &[
      "muse.ai",
      "meta.com",
      "meta.ai",
      "facebook.com",
      "instagram.com",
      "fb.com",
      "appleid.apple.com",
      "idmsa.apple.com",
    ],
  },
  ProviderSpec {
    info: ProviderInfo {
      id: ProviderId::Hark,
      name: "Hark",
      short_name: "Hark",
      enabled: true,
      status_text: "已启用",
      entry_url: "https://app.hark.com/",
      homepage_url: "https://hark.com/",
      callback_origins: &["https://app.hark.com", "https://hark.com"],
      verified_methods: &["email", "phone", "apple"],
    },
    allowed_hosts: &[
      "app.hark.com",
      "hark.com",
      "appleid.apple.com",
      "idmsa.apple.com",
    ],
  },
];

pub fn get_provider(id: ProviderId) -> &'static ProviderSpec {
  PROVIDERS
    .iter()
    .find(|p| p.info.id == id)
    .expect("provider must exist")
}

pub fn all_provider_infos() -> Vec<ProviderInfo> {
  PROVIDERS.iter().map(|p| p.info.clone()).collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavigationDecision {
  AllowBlank,
  AllowHttps,
  ExternalGoogleOAuth,
  Deny,
}

fn host_matches(host: &str, domain: &str) -> bool {
  if host.eq_ignore_ascii_case(domain) {
    return true;
  }
  let suffix = format!(".{}", domain.to_ascii_lowercase());
  host.to_ascii_lowercase().ends_with(&suffix)
}

pub fn classify_top_level_url(provider_id: ProviderId, url: &Url, allow_blank: bool) -> NavigationDecision {
  if allow_blank && url.as_str() == "about:blank" {
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
  if spec.allowed_hosts.iter().any(|allowed| host_matches(host, allowed)) {
    NavigationDecision::AllowHttps
  } else {
    NavigationDecision::Deny
  }
}

pub fn is_verified_callback_origin(provider_id: ProviderId, url: &Url) -> bool {
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
