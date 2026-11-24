const APP_COMMANDS: &[&str] = &[
  "get_manager_state",
  "select_provider",
  "add_account",
  "rename_account",
  "set_account_note",
  "reorder_accounts",
  "add_teleagent_account",
  "update_teleagent_token",
  "add_glados_account",
  "update_glados_cookie",
  "retry_account_view",
  "refresh_all_quotas",
  "remove_account",
  "switch_account",
  "set_modal_active",
  "open_official_site",
  "resolve_uuid_conflict",
  "dismiss_notice",
  "set_proxy_url",
  "set_warm_view_limit",
  "set_proxy_follow_system",
  "trigger_quota_sync",
  "check_for_updates",
  "download_and_install_update",
  "open_external_url",
  "get_notification_status",
  "send_test_notification",
  "open_notification_settings",
];

fn main() {
  let attributes = tauri_build::Attributes::new()
    .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS));
  tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
