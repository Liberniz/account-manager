import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./styles.css";
import type {
  AccountKey,
  AccountRecord,
  InstallUpdateOutcome,
  ManagerSnapshot,
  ProviderId,
  ProviderInfo,
  QuotaDetail,
  UpdateCheckResult,
  UpdateProgressEvent,
  GlobalChatHit,
  GroupData,
  ChatGroupView,
  GlobalSearchResult,
} from "./types";

type ModalMode =
  | { kind: "none" }
  | { kind: "add"; providerId: ProviderId; draft: string; cookieDraft: string }
  | { kind: "add-glados"; domainDraft: string; cookieDraft: string }
  | { kind: "update-glados"; account: AccountRecord; cookieDraft: string }
  | { kind: "rename"; account: AccountRecord; draft: string; noteDraft: string }
  | { kind: "remove"; account: AccountRecord }
  | { kind: "proxy"; draft: string; warmLimit: string; followSystem: boolean; autoApprove: boolean }
  | { kind: "notify"; status: string; testNote: string }
  | { kind: "add-site"; nameDraft: string; urlDraft: string }
  | { kind: "remove-site"; defId: string; name: string }
  | { kind: "update" };

const PROVIDER_LOGOS: Record<ProviderId, { src: string; fullBleed: boolean }> = {
  muse: { src: "/logos/muse.png", fullBleed: true },
  glados: { src: "/logos/glados.svg", fullBleed: true },
};

const GLADOS_DOMAINS = [
  "glados.cloud",
  "glados.one",
  "glados.rocks",
  "glados-facility.com",
  "railgun.info",
];

const ICON_EXTERNAL = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
const ICON_REFRESH = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>`;
const ICON_EDIT = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`;
const ICON_KEY = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M11 12L21 2"/><path d="M16 7l3 3"/></svg>`;
const ICON_TRASH = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
const ICON_USER_PLUS = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>`;
const ICON_UPDATE = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
const ICON_PROXY = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;
const ICON_BELL = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`;

let snapshot: ManagerSnapshot | null = null;
let groupData: GroupData | null = null;
let groupPanelOpen = false;
let currentGroupId: string | null = null;
let groupPollTimer: number | null = null;
let modal: ModalMode = { kind: "none" };
let optimisticSwitching: AccountKey | null = null;
let accountSearchQuery = "";
let chatSearchQuery = "";
let chatSearchLoading = false;
let chatSearchResult: GlobalSearchResult | null = null;
let chatSearchError = "";
let chatSearchTimer: number | undefined;
let dragInProgress = false;
let suppressNextClick = false;
let busy = false;
let lastRenderedUpdateStage: string | null = null;

const updateState: {
  checking: boolean;
  installing: boolean;
  result: UpdateCheckResult | null;
  progress: UpdateProgressEvent | null;
  error: string | null;
  outcomeStatus: string | null;
  outcomeMessage: string | null;
} = {
  checking: false,
  installing: false,
  result: null,
  progress: null,
  error: null,
  outcomeStatus: null,
  outcomeMessage: null,
};

const scrollOffsets: Record<ProviderId, number> = {
  muse: 0,
  glados: 0,
};

function isSameKey(a: AccountKey | null, b: AccountRecord): boolean {
  return Boolean(a && a.providerId === b.providerId && a.uuid === b.uuid);
}

function effectiveSwitchingKey(state: ManagerSnapshot): AccountKey | null {
  return state.switchingAccount ?? optimisticSwitching;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderProviderLogo(id: ProviderId, extraClass = "", label = ""): string {
  const cfg = PROVIDER_LOGOS[id];
  if (!cfg) {
    const letter = (Array.from(label.trim())[0] ?? "S").toUpperCase();
    return `<span class="logo-letter ${extraClass}" aria-hidden="true">${escapeHtml(letter)}</span>`;
  }
  const cls = `${extraClass} ${cfg.fullBleed ? "full-bleed" : ""}`.trim();
  return `<img src="${cfg.src}" alt="${escapeHtml(id)}" class="${cls}" draggable="false" />`;
}

function computeAvatarText(acc: AccountRecord): string {
  if (acc.autoAlias) {
    return "@";
  }
  const clean = acc.alias.trim();
  const first = Array.from(clean)[0];
  return first ? first.toUpperCase() : "#";
}

function fmtDateMs(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function splitQuotaValue(raw: string): { main: string; note: string | null } {
  const m = raw.trim().match(/^(.*?)\s*[（(]([^）)]+)[）)]\s*$/);
  if (m && m[1].trim()) {
    return { main: m[1].trim(), note: m[2].trim() };
  }
  return { main: raw.trim(), note: null };
}

type QuotaStatus = "normal" | "extra" | "low" | "critical";

function resolveQuotaState(acc: AccountRecord): {
  status: QuotaStatus;
  label: string;
  extraDepleted: boolean;
} {
  if (acc.quotaDetail) {
    const d = acc.quotaDetail;
    const planUsed = d.planUsedPercent;
    const planVal = d.planValue || "";
    const planDepleted =
      (planUsed !== null && planUsed >= 100) ||
      planVal.includes("用尽") ||
      planVal.includes("DEPLETED");
    const planLow =
      !planDepleted &&
      ((planUsed !== null && planUsed >= 85) ||
        planVal.includes("偏低") ||
        planVal.includes("LOW"));
    const hasExtra = Boolean(
      d.extraLabel || d.extraValue || d.extraUsedPercent !== null
    );
    const extraUsed = d.extraUsedPercent;
    const extraVal = d.extraValue || "";
    const extraDepleted =
      hasExtra &&
      ((extraUsed !== null && extraUsed >= 100) ||
        extraVal.includes("用尽") ||
        extraVal.includes("耗尽") ||
        extraVal.includes("DEPLETED") ||
        /剩余\s*0(\s|个|口|$)/.test(extraVal));
    const extraLow =
      hasExtra &&
      !extraDepleted &&
      ((extraUsed !== null && extraUsed >= 85) ||
        extraVal.includes("偏低") ||
        extraVal.includes("LOW"));
    const extraIsCap = Boolean(d.extraLabel && /月|monthly/i.test(d.extraLabel));

    if (extraIsCap) {
      if (planDepleted) {
        return { status: "critical", label: "日满", extraDepleted };
      }
      if (extraDepleted) {
        return { status: "critical", label: "月满", extraDepleted };
      }
      if (planLow || extraLow) {
        return { status: "low", label: "偏低", extraDepleted };
      }
      return { status: "normal", label: "", extraDepleted };
    }

    if (planDepleted) {
      if (!hasExtra || extraDepleted) {
        return { status: "critical", label: "用尽", extraDepleted };
      }
      if (extraLow) {
        return { status: "low", label: "偏低", extraDepleted };
      }
      return { status: "extra", label: "用额外", extraDepleted };
    }
    if (planLow) {
      if (!hasExtra || extraDepleted) {
        return { status: "low", label: "偏低", extraDepleted };
      }
      return { status: "normal", label: "", extraDepleted };
    }
    return { status: "normal", label: "", extraDepleted };
  }

  if (acc.quotaPercent === 0 || Boolean(acc.quotaText?.includes("用尽"))) {
    return { status: "critical", label: "用尽", extraDepleted: false };
  }
  if (
    (typeof acc.quotaPercent === "number" && acc.quotaPercent <= 15) ||
    Boolean(acc.quotaText?.includes("偏低"))
  ) {
    return { status: "low", label: "偏低", extraDepleted: false };
  }
  return { status: "normal", label: "", extraDepleted: false };
}

function formatShortResetText(raw: string | null): string {
  const clean = (raw ?? "").trim();
  if (!clean) return "";
  const m = clean.match(/^(?:每周限额将在|周限额重置时间[:：]?|将在)\s*(.+?)\s*$/);
  if (m && m[1]) {
    const inner = m[1].trim();
    return inner.endsWith("重置") ? inner : `${inner}重置`;
  }
  return clean;
}

function formatShortExtraText(
  detail: QuotaDetail,
  extraDepleted: boolean
): string | null {
  if (
    !detail.extraLabel &&
    !detail.extraValue &&
    detail.extraUsedPercent === null
  ) {
    return null;
  }
  const prefix = detail.extraLabel && /月|monthly/i.test(detail.extraLabel) ? "月" : "额外";
  if (extraDepleted) {
    return `${prefix} 100% · 已耗尽`;
  }
  const parsed = splitQuotaValue(detail.extraValue ?? "");
  const pctPart =
    typeof detail.extraUsedPercent === "number"
      ? `${detail.extraUsedPercent}%`
      : parsed.main.replace(/^已使用\s*/, "").trim();
  const notePart = parsed.note
    ? parsed.note
        .replace(/^剩余\s*/, "余 ")
        .replace(/个?口令$/, "")
        .replace(/\s*tokens?$/i, "")
        .trim()
    : "";
  if (pctPart && notePart) {
    return `${prefix} ${pctPart} · ${notePart}`;
  }
  if (notePart) {
    return `${prefix} · ${notePart}`;
  }
  if (pctPart) {
    return `${prefix} ${pctPart}`;
  }
  return detail.extraLabel ?? "额外额度";
}

function renderQuotaDetailPanel(
  detail: QuotaDetail,
  status: QuotaStatus,
  extraDepleted: boolean
): string {
  const shortVal =
    typeof detail.planUsedPercent === "number"
      ? `${detail.planUsedPercent}%`
      : splitQuotaValue(detail.planValue).main;
  const clamped =
    typeof detail.planUsedPercent === "number"
      ? Math.max(0, Math.min(100, detail.planUsedPercent))
      : null;
  const barHtml =
    clamped !== null
      ? `<div class="quota-bar-track ${status}"><div class="quota-bar-fill ${status} ${clamped > 0 ? "has-fill" : ""}" style="width:${clamped}%"></div></div>`
      : `<div class="quota-compact-spacer"></div>`;

  const rawReset = detail.planSubtext ?? "";
  const shortReset = formatShortResetText(rawReset);
  const shortExtra = formatShortExtraText(detail, extraDepleted);
  const fullExtraTitle = [
    detail.extraLabel,
    detail.extraValue,
    detail.extraSubtext,
  ]
    .filter(Boolean)
    .join(" · ");

  const metaHtml =
    shortReset || shortExtra
      ? `
        <div class="quota-compact-meta">
          <span class="quota-sub-text" title="${escapeHtml(rawReset)}">${escapeHtml(shortReset)}</span>
          ${shortExtra ? `<span class="quota-extra-pill ${status}" title="${escapeHtml(fullExtraTitle)}">${escapeHtml(shortExtra)}</span>` : ""}
        </div>
      `
      : "";

  return `
    <div class="quota-compact-main">
      <span class="quota-plan-label ${status}">${escapeHtml(detail.planLabel)}</span>
      ${barHtml}
      <span class="quota-val ${status}">${escapeHtml(shortVal)}</span>
    </div>
    ${metaHtml}
  `;
}

function saveScrollPosition(): void {
  if (!snapshot) return;
  const listEl = document.querySelector<HTMLElement>(".account-list");
  if (listEl) {
    scrollOffsets[snapshot.selectedProviderId] = listEl.scrollTop;
  }
}

function restoreScrollPosition(): void {
  if (!snapshot) return;
  const listEl = document.querySelector<HTMLElement>(".account-list");
  if (listEl) {
    listEl.scrollTop = scrollOffsets[snapshot.selectedProviderId] ?? 0;
  }
}

function rerenderPreservingScroll(): void {
  saveScrollPosition();
  render();
  restoreScrollPosition();
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx += 1;
  }
  return idx === 0 ? `${Math.round(val)} B` : `${val.toFixed(1)} ${units[idx]}`;
}

function formatProgressSummary(evt: UpdateProgressEvent): string {
  if (evt.stage === "verifying") return "校验中";
  if (evt.stage === "installing") return "正在替换";
  if (evt.stage === "ready") return "完成";
  if (evt.stage === "needs_permission") return "待授权";
  const pct = typeof evt.percent === "number" ? `${evt.percent}%` : "";
  const transferred = evt.total
    ? `${formatBytes(evt.downloaded)} / ${formatBytes(evt.total)}`
    : evt.downloaded > 0
      ? formatBytes(evt.downloaded)
      : "";
  if (pct && transferred) return `${pct} · ${transferred}`;
  return pct || transferred;
}

async function runCheckForUpdates(silent: boolean): Promise<void> {
  if (updateState.checking || updateState.installing) return;
  updateState.checking = true;
  if (!silent) {
    updateState.error = null;
    updateState.outcomeStatus = null;
    updateState.outcomeMessage = null;
    if (modal.kind === "update") {
      rerenderPreservingScroll();
    }
  }
  try {
    const res = await invoke<UpdateCheckResult>("check_for_updates");
    updateState.result = res;
    updateState.error = null;
  } catch (err) {
    if (!silent) {
      updateState.error = String(err);
    }
  } finally {
    updateState.checking = false;
    if (!silent || updateState.result?.hasUpdate || modal.kind === "update") {
      rerenderPreservingScroll();
    }
  }
}

async function runDownloadAndInstall(): Promise<void> {
  const res = updateState.result;
  if (!res?.downloadUrl || updateState.checking || updateState.installing) return;
  updateState.installing = true;
  updateState.error = null;
  updateState.outcomeStatus = null;
  updateState.outcomeMessage = null;
  lastRenderedUpdateStage = "downloading";
  updateState.progress = {
    stage: "downloading",
    downloaded: 0,
    total: res.size,
    percent: 0,
    message: "正在准备下载...",
  };
  rerenderPreservingScroll();
  try {
    const outcome = await invoke<InstallUpdateOutcome>("download_and_install_update", {
      request: {
        version: res.latestVersion,
        downloadUrl: res.downloadUrl,
        sha256: res.sha256,
        filename: res.filename,
      },
    });
    updateState.outcomeStatus = outcome.status;
    updateState.outcomeMessage = outcome.message;
  } catch (err) {
    updateState.error = String(err);
  } finally {
    updateState.installing = false;
    rerenderPreservingScroll();
  }
}

async function setModal(next: ModalMode): Promise<void> {
  const wasActive = modal.kind !== "none";
  const isActive = next.kind !== "none";
  modal = next;
  if (wasActive !== isActive) {
    try {
      snapshot = await invoke<ManagerSnapshot>("set_modal_active", {
        active: isActive,
      });
    } catch (err) {
      if (snapshot) {
        snapshot = { ...snapshot, notice: String(err) };
      }
    }
  }
  render();
  if (next.kind === "add" || next.kind === "rename") {
    const input = document.querySelector<HTMLInputElement>("#modal-alias-input");
    if (input) {
      input.focus();
      input.select();
    }
  } else if (next.kind === "proxy") {
    const input = document.querySelector<HTMLInputElement>("#modal-proxy-input");
    if (input) {
      input.focus();
      input.select();
    }
  } else if (next.kind === "remove") {
    document.querySelector<HTMLButtonElement>("#modal-confirm-btn")?.focus();
  }
}

async function callCommand(
  cmd: string,
  args: Record<string, unknown> = {},
  optimisticTarget: AccountKey | null = null
): Promise<void> {
  if (busy) return;
  busy = true;
  saveScrollPosition();
  if (optimisticTarget) {
    optimisticSwitching = optimisticTarget;
    if (snapshot) {
      snapshot = { ...snapshot, activeAccount: null };
    }
    render();
    restoreScrollPosition();
  }
  try {
    snapshot = await invoke<ManagerSnapshot>(cmd, args);
  } catch (err) {
    if (snapshot) {
      snapshot = { ...snapshot, notice: String(err) };
    }
  } finally {
    optimisticSwitching = null;
    busy = false;
    render();
    restoreScrollPosition();
  }
}

function currentProvider(state: ManagerSnapshot): ProviderInfo {
  return (
    state.providers.find((p) => p.id === state.selectedProviderId) ??
    state.providers[0]
  );
}

function renderUpdateModal(): string {
  const res = updateState.result;
  const curVer = res ? res.currentVersion : "...";
  const hasUpdate = Boolean(res?.hasUpdate);
  const title = hasUpdate
    ? `发现新版本 v${escapeHtml(res!.latestVersion)}`
    : "检查更新";

  const versionRow = res
    ? `
      <div class="update-version-row">
        <span class="update-version-pill">当前 v${escapeHtml(curVer)}</span>
        ${
          hasUpdate
            ? `<span>→</span><span class="update-version-pill latest">最新 v${escapeHtml(res.latestVersion)}</span>`
            : ""
        }
        ${res.size ? `<span class="update-size-label">${escapeHtml(formatBytes(res.size))}</span>` : ""}
      </div>
    `
    : `<div class="modal-desc">正在连接 GitHub Releases 检查版本信息...</div>`;

  let bodyHtml = "";
  if (updateState.checking && !res) {
    bodyHtml = `
      <div class="update-progress-wrap">
        <div class="update-progress-track"><div class="update-progress-fill indeterminate"></div></div>
      </div>
    `;
  } else if (res) {
    const noteText = res.releaseNotes.trim();
    if (hasUpdate) {
      bodyHtml += `<div class="update-notes">${escapeHtml(noteText || "包含稳定性改进与问题修复。")}</div>`;
      if (!res.downloadUrl) {
        bodyHtml += `<div class="modal-desc">当前发布尚未包含本平台自动安装包，请点击「发布页」手动下载。</div>`;
      }
    } else {
      bodyHtml += `<div class="modal-desc">${escapeHtml(noteText || "当前已是最新版本。")}</div>`;
    }
  }

  const prog = updateState.progress;
  const showProgress =
    prog &&
    prog.stage !== "error" &&
    (updateState.installing ||
      updateState.outcomeStatus === "restarting" ||
      prog.stage === "ready");
  if (showProgress) {
    lastRenderedUpdateStage = prog.stage;
    const isIndeterminate = prog.percent === null;
    const widthStyle = isIndeterminate ? "" : `style="width:${Math.max(0, Math.min(100, prog.percent!))}%"`;
    bodyHtml += `
      <div class="update-progress-wrap">
        <div class="update-progress-meta">
          <span id="update-progress-text">${escapeHtml(prog.message)}</span>
          <span id="update-progress-pct" class="update-progress-pct">${escapeHtml(formatProgressSummary(prog))}</span>
        </div>
        <div class="update-progress-track">
          <div id="update-progress-bar" class="update-progress-fill ${isIndeterminate ? "indeterminate" : ""}" ${widthStyle}></div>
        </div>
      </div>
    `;
  }

  if (updateState.outcomeMessage) {
    bodyHtml += `<div class="update-outcome-box">${escapeHtml(updateState.outcomeMessage)}</div>`;
  }
  if (updateState.error) {
    bodyHtml += `<div class="update-error-box">${escapeHtml(updateState.error)}</div>`;
  }

  const canInstall = hasUpdate && Boolean(res?.downloadUrl);
  const disablePrimary =
    updateState.checking ||
    updateState.installing ||
    updateState.outcomeStatus === "restarting";
  const primaryBtn = canInstall
    ? `<button id="update-install-btn" class="btn primary" type="button" ${disablePrimary ? "disabled" : ""}>${
        updateState.installing
          ? "更新中..."
          : updateState.outcomeStatus === "needs_permission"
            ? "已授权，继续安装"
            : "立即下载并更新"
      }</button>`
    : `<button id="update-recheck-btn" class="btn primary" type="button" ${disablePrimary ? "disabled" : ""}>${
        updateState.checking ? "检查中..." : "重新检查"
      }</button>`;

  const pageBtn = res?.releasePageUrl
    ? `<button id="update-open-page-btn" class="btn" type="button">发布页</button>`
    : "";

  return `
    <div class="inline-modal" role="dialog" aria-modal="true">
      <div class="modal-card">
        <div class="modal-title">${title}</div>
        ${versionRow}
        ${bodyHtml}
        <div class="modal-footer">
          <button id="modal-cancel-btn" class="btn" type="button" ${updateState.installing ? "disabled" : ""}>关闭</button>
          ${pageBtn}
          ${primaryBtn}
        </div>
      </div>
    </div>
  `;
}

function renderModal(provider: ProviderInfo): string {
  if (modal.kind === "none") return "";
  if (modal.kind === "update") {
    return renderUpdateModal();
  }
  if (modal.kind === "add") {
    return `
      <div class="inline-modal" role="dialog" aria-modal="true">
        <div class="modal-card">
          <div class="modal-title">新增 ${escapeHtml(provider.shortName)} 账号</div>
          <div class="modal-desc">每个账号拥有独立隔离的登录态。备注可留空，登录成功后将自动显示邮箱名称。</div>
          <input id="modal-alias-input" class="modal-input" maxlength="60" placeholder="备注名称（留空则自动获取登录邮箱）" value="${escapeHtml(modal.draft)}" />
          <div class="modal-desc" style="margin-top:14px; margin-bottom:6px;">导入 Cookie 登录（可选）：已在浏览器登录过时，粘贴 Cookie 可直接进入已登录状态，免走网页登录。支持浏览器扩展导出的 JSON 数组、cookies.txt，或 F12 请求头里的 Cookie 整行；同时导入 muse.ai 与 meta.com 的 Cookie 时邮箱也能自动识别。Cookie 只存本机。</div>
          <textarea id="modal-import-cookie" class="modal-input modal-textarea" rows="3" placeholder="粘贴 Cookie（可留空，留空则打开网页登录）">${escapeHtml(modal.cookieDraft)}</textarea>
          <div class="modal-footer">
            <button id="modal-cancel-btn" class="btn" type="button">取消</button>
            <button id="modal-confirm-btn" class="btn primary" type="button">创建并打开</button>
          </div>
        </div>
      </div>
    `;
  }
  if (modal.kind === "rename") {
    return `
      <div class="inline-modal" role="dialog" aria-modal="true">
        <div class="modal-card">
          <div class="modal-title">修改备注名称</div>
          <div class="modal-desc">仅更新本机列表中的显示名称，不影响已登录的官方会话。</div>
          <input id="modal-alias-input" class="modal-input" maxlength="60" placeholder="输入新的备注名称" value="${escapeHtml(modal.draft)}" />
          <div class="modal-desc" style="margin-top:14px;">账号备注：自由文本（如「工作号 · 客户 A 项目」），显示在账号列表与托盘菜单中，方便区分每个号的用途。</div>
          <input id="modal-note-input" class="modal-input" maxlength="200" placeholder="输入备注（可留空）" value="${escapeHtml(modal.noteDraft)}" />
          <div class="modal-footer">
            <button id="modal-cancel-btn" class="btn" type="button">取消</button>
            <button id="modal-confirm-btn" class="btn primary" type="button">保存</button>
          </div>
        </div>
      </div>
    `;
  }
  if (modal.kind === "add-glados") {
    const currentDomain = modal.domainDraft;
    const domainOptions = GLADOS_DOMAINS.map(
      (d) =>
        `<option value="${d}" ${d === currentDomain ? "selected" : ""}>${d}</option>`,
    ).join("");
    return `
      <div class="inline-modal" role="dialog" aria-modal="true">
        <div class="modal-card">
          <div class="modal-title">新增 GLaDOS 账号</div>
          <div class="modal-desc">不走网页登录：选账号所在站点，粘贴整行 Cookie，叠号会先验活再保存、并把 Cookie 种入该账号的隔离视图直接进入控制台。签到请在右侧控制台页面里点（站点有人机验证，接口代签拿不到满分）。Cookie 只存本机。</div>
          <div class="modal-desc" style="margin-bottom:6px;">站点域名（账号在哪个站点注册就选哪个）：</div>
          <select id="modal-domain-select" class="modal-input">${domainOptions}</select>
          <div class="modal-desc" style="margin-top:14px; margin-bottom:6px;">Cookie 整行：在该站点登录后按 F12 → Network（网络）→ 点任一请求 → 在请求头里复制 Cookie 整行。必须包含 gld:sess 与 gld:sess.sig。</div>
          <textarea id="modal-cookie-input" class="modal-input modal-textarea" rows="4" placeholder="粘贴 Cookie 整行">${escapeHtml(modal.cookieDraft)}</textarea>
          <div class="modal-footer">
            <button id="modal-cancel-btn" class="btn" type="button">取消</button>
            <button id="modal-confirm-btn" class="btn primary" type="button">验证并添加</button>
          </div>
        </div>
      </div>
    `;
  }
  if (modal.kind === "update-glados") {
    const d = modal.account.gdLeftDays;
    const statusText =
      typeof d === "number"
        ? d > 0
          ? `当前剩余 ${Math.floor(d)} 天（${escapeHtml(modal.account.gdDomain)}）`
          : `当前已过期（${escapeHtml(modal.account.gdDomain)}）`
        : `站点：${escapeHtml(modal.account.gdDomain)}`;
    return `
      <div class="inline-modal" role="dialog" aria-modal="true">
        <div class="modal-card">
          <div class="modal-title">更新 Cookie · ${escapeHtml(modal.account.alias)}</div>
          <div class="modal-desc">${statusText}。在该站点重新登录后，按 F12 → Network → 任一请求 → 复制 Cookie 整行粘贴到这里；保存前会先验活，视图会自动刷新为新登录态。</div>
          <textarea id="modal-cookie-input" class="modal-input modal-textarea" rows="4" placeholder="粘贴新的 Cookie 整行">${escapeHtml(modal.cookieDraft)}</textarea>
          <div class="modal-footer">
            <button id="modal-cancel-btn" class="btn" type="button">取消</button>
            <button id="modal-confirm-btn" class="btn primary" type="button">验证并保存</button>
          </div>
        </div>
      </div>
    `;
  }
  if (modal.kind === "add-site") {
    return `
      <div class="inline-modal" role="dialog" aria-modal="true">
        <div class="modal-card">
          <div class="modal-title">添加自定义服务</div>
          <div class="modal-desc">填任意网站的网址（https），它会像 Muse / GLaDOS 一样出现在服务栏里，可添加多个隔离账号、网页登录使用。注意：只有真正的网页版站点才适用；只有 App、没有网页控制台的服务加进来也只能看到下载页。</div>
          <input id="modal-site-name" class="modal-input" maxlength="24" placeholder="服务名称，如 Cue" value="${escapeHtml(modal.nameDraft)}" />
          <input id="modal-site-url" class="modal-input" style="margin-top:10px;" maxlength="300" placeholder="https://example.com/" value="${escapeHtml(modal.urlDraft)}" />
          <div class="modal-footer">
            <button id="modal-cancel-btn" class="btn" type="button">取消</button>
            <button id="modal-confirm-btn" class="btn primary" type="button">添加服务</button>
          </div>
        </div>
      </div>
    `;
  }
  if (modal.kind === "remove-site") {
    return `
      <div class="inline-modal" role="dialog" aria-modal="true">
        <div class="modal-card">
          <div class="modal-title">删除自定义服务</div>
          <div class="modal-desc">删除「${escapeHtml(modal.name)}」服务定义。该服务名下还有账号时会被拒绝，请先删除账号。</div>
          <div class="modal-footer">
            <button id="modal-cancel-btn" class="btn" type="button">取消</button>
            <button id="modal-confirm-btn" class="btn danger" type="button">删除服务</button>
          </div>
        </div>
      </div>
    `;
  }
  if (modal.kind === "proxy") {
    return `
      <div class="inline-modal" role="dialog" aria-modal="true">
        <div class="modal-card">
          <div class="modal-title">代理设置（macOS）</div>
          <div class="modal-desc">账号页面与应用内更新的流量将经此代理。支持 http:// 或 socks5://，需带端口，如 http://127.0.0.1:7890；暂不支持带账号密码的代理。保存后已打开的账号视图会关闭，重新打开账号时生效；清空并保存即关闭代理。</div>
          <input id="modal-proxy-input" class="modal-input" maxlength="120" placeholder="http://127.0.0.1:7890（留空关闭代理）" value="${escapeHtml(modal.draft)}" />
          <label class="modal-check-row">
            <input id="modal-proxy-follow" type="checkbox" ${modal.followSystem ? "checked" : ""} />
            <span>跟随系统代理：自动读取 macOS 系统代理设置（如 Clash / Surge 开启的系统代理），勾选后忽略上方手动地址</span>
          </label>
          <div class="modal-desc" style="margin-top:14px;">保活视图上限（仅 Muse）：后台保持就绪的账号视图数量，可填 1-32 任意数值；留空 = 默认 6，填 0 = 不限。越多切换越快、内存占用越高；闲置超过 30 分钟的保活视图会自动回收，冷账号的额度会通过临时视图轮流刷新，不占用保活名额。GLaDOS 不保活，离开即关、冷加载打开。</div>
          <input id="modal-warm-limit" class="modal-input" type="number" min="0" max="32" step="1" placeholder="默认 6" value="${escapeHtml(modal.warmLimit)}" />
          <div class="modal-desc" style="margin-top:14px;">工具权限自动审批：开启后，前台与后台保活的 Muse 账号出现权限审批卡时，叠号会自动点击「允许一次」，并发送一条系统通知告知。涉及删除、注销、退出登录、支付、改密等高危操作的卡片会被拦截、不会自动批准。默认关闭，确认你信任正在跑的任务再开。</div>
          <label class="modal-check-row">
            <input id="modal-auto-approve" type="checkbox" ${modal.autoApprove ? "checked" : ""} />
            <span>自动审批权限请求（前台与后台保活账号）</span>
          </label>
          ${snapshot ? `<div class="modal-desc" style="margin-top:10px;">当前保活视图：${snapshot.warmViewCount} 个（上限 ${snapshot.warmViewLimit === null ? "默认 6" : snapshot.warmViewLimit === 0 ? "不限" : snapshot.warmViewLimit}）</div>` : ""}
          <div class="modal-footer">
            <button id="modal-cancel-btn" class="btn" type="button">取消</button>
            <button id="modal-confirm-btn" class="btn primary" type="button">保存</button>
          </div>
        </div>
      </div>
    `;
  }
  if (modal.kind === "notify") {
    const statusText =
      modal.status === "authorized"
        ? "已开启"
        : modal.status === "provisional"
          ? "已开启（静默投递，进通知中心但不弹横幅）"
          : modal.status === "denied"
            ? "已被系统关闭"
            : modal.status === "not_determined"
              ? "尚未决定（发送测试通知时会弹出授权请求）"
              : "未知";
    return `
      <div class="inline-modal" role="dialog" aria-modal="true">
        <div class="modal-card">
          <div class="modal-title">系统通知</div>
          <div class="modal-desc">后台账号等待审批、会话完成、登录过期时，叠号会通过 macOS 通知中心提醒你；你正在看的那个账号不会打扰。通知按账号分组，点开通知会回到叠号。</div>
          <div class="modal-desc" style="margin-top:10px;">当前状态：<strong>${escapeHtml(statusText)}</strong></div>
          ${modal.testNote ? `<div class="modal-desc" style="margin-top:10px;">${escapeHtml(modal.testNote)}</div>` : ""}
          <div class="modal-footer">
            <button id="notify-open-settings-btn" class="btn" type="button">打开系统通知设置</button>
            <button id="notify-test-btn" class="btn" type="button">发送测试通知</button>
            <button id="modal-cancel-btn" class="btn primary" type="button">关闭</button>
          </div>
        </div>
      </div>
    `;
  }
  return `
    <div class="inline-modal" role="dialog" aria-modal="true">
      <div class="modal-card">
        <div class="modal-title">移除「${escapeHtml(modal.account.alias)}」</div>
        <div class="modal-desc">将关闭该视图并彻底清除本机独立浏览资料（Cookie 与存储）。云端账号及历史对话仍由官方保留。</div>
        <div class="modal-footer">
          <button id="modal-cancel-btn" class="btn" type="button">取消</button>
          <button id="modal-confirm-btn" class="btn danger" type="button">确认移除</button>
        </div>
      </div>
    </div>
  `;
}

function renderMiddleContent(state: ManagerSnapshot, provider: ProviderInfo): string {
  const providerAccounts = state.accounts.filter((a) => a.providerId === provider.id);
  const switchingKey = effectiveSwitchingKey(state);

  const noticeHtml = state.notice
    ? `
      <div class="notice-bar">
        <span>${escapeHtml(state.notice)}</span>
        <button id="dismiss-notice-btn" class="notice-close" type="button" title="关闭提示">✕</button>
      </div>
    `
    : "";

  const conflictsHtml = state.conflicts
    .map(
      (c) => `
      <div class="conflict-box">
        <div>检测到 UUID 归属冲突（${escapeHtml(c.uuid.slice(0, 8))}…），请选择保留归属服务：</div>
        <div class="conflict-actions">
          ${c.providers
            .map(
              (pid) =>
                `<button class="mini-btn" data-resolve-uuid="${escapeHtml(c.uuid)}" data-resolve-provider="${escapeHtml(pid)}" type="button">归属 ${escapeHtml(pid.toUpperCase())}</button>`
            )
            .join("")}
        </div>
      </div>
    `
    )
    .join("");

  const headerBtnHtml = provider.enabled
    ? `
      <button id="sync-all-btn" class="ghost-icon-btn" type="button" title="刷新全部账号额度">${ICON_REFRESH}</button>
      <button id="open-site-btn" class="ghost-icon-btn" type="button" title="在浏览器中打开 ${escapeHtml(provider.shortName)} 官网">${ICON_EXTERNAL}</button>
      <button id="add-account-btn" class="icon-btn primary" type="button">+ 新增</button>
    `
    : `<button id="open-site-btn" class="icon-btn primary" type="button">打开官网 ${ICON_EXTERNAL}</button>`;

  // 额度总览：推荐账号 + 当前账号耗尽时的一键切换
  const loggedInAccounts = providerAccounts.filter((a) => a.authState === "authenticated");
  const activeAcc =
    providerAccounts.find(
      (a) => state.activeAccount?.providerId === a.providerId && state.activeAccount?.uuid === a.uuid
    ) ?? null;
  const activeDepleted = activeAcc ? resolveQuotaState(activeAcc).status === "critical" : false;
  const recommended =
    loggedInAccounts
      .filter(
        (a) =>
          a !== activeAcc &&
          typeof a.quotaPercent === "number" &&
          resolveQuotaState(a).status !== "critical"
      )
      .sort((x, y) => (y.quotaPercent ?? 0) - (x.quotaPercent ?? 0))[0] ?? null;
  const waitingAccounts = providerAccounts.filter(
    (a) => a.sessionState === "waiting" && a.authState !== "logged_out"
  );
  const depletedOther = loggedInAccounts.find(
    (a) =>
      a !== activeAcc &&
      resolveQuotaState(a).status === "critical" &&
      Boolean(a.quotaDetail?.planSubtext)
  );
  let overviewHtml = "";
  if (waitingAccounts.length > 0) {
    const first = waitingAccounts[0];
    overviewHtml = `
      <div class="quota-overview waiting">
        <span>${waitingAccounts.length} 个账号待审批</span>
        <button class="mini-btn overview-switch-btn" data-switch-uuid="${escapeHtml(first.uuid)}" type="button">切到「${escapeHtml(first.alias)}」处理</button>
      </div>`;
  } else if (providerAccounts.length >= 2) {
    if (activeDepleted && recommended) {
      overviewHtml = `
      <div class="quota-overview depleted">
        <span>当前账号额度已用尽${activeAcc?.quotaDetail?.planSubtext ? ` · ${escapeHtml(activeAcc.quotaDetail.planSubtext)}` : ""}</span>
        <button class="mini-btn overview-switch-btn" data-switch-uuid="${escapeHtml(recommended.uuid)}" type="button">切到「${escapeHtml(recommended.alias)}」（剩余 ${recommended.quotaPercent}%）</button>
      </div>`;
    } else if (recommended) {
      overviewHtml = `
      <div class="quota-overview">
        <span>${loggedInAccounts.length} 个已登录 · 推荐「${escapeHtml(recommended.alias)}」（剩余 ${recommended.quotaPercent}%）${depletedOther ? ` · 「${escapeHtml(depletedOther.alias)}」已用尽，${escapeHtml(depletedOther.quotaDetail!.planSubtext!)}` : ""}</span>
        <button class="mini-btn overview-switch-btn" data-switch-uuid="${escapeHtml(recommended.uuid)}" type="button">切过去</button>
      </div>`;
    } else if (loggedInAccounts.length > 0) {
      overviewHtml = `
      <div class="quota-overview">
        <span>${loggedInAccounts.length} 个已登录账号</span>
      </div>`;
    }
  }

  let listBody = "";
  if (!provider.enabled) {
    listBody = `
      <div class="empty-list">
        <div class="empty-icon-circle">${renderProviderLogo(provider.id)}</div>
        <div><strong>${escapeHtml(provider.name)}</strong> 暂未开放内嵌会话</div>
        <div>待核验官方网页直登路径与嵌入条款后启用，可点击右上角访问官网。</div>
      </div>
    `;
  } else if (providerAccounts.length === 0) {
    listBody = `
      <div class="empty-list">
        <div class="empty-icon-circle">${ICON_USER_PLUS}</div>
        <div>暂无 ${escapeHtml(provider.shortName)} 账号</div>
        <div>${provider.id === "glados" ? "点击右上角「+ 新增」粘贴 Cookie 添加" : "点击右上角「+ 新增」创建独立登录环境"}</div>
      </div>
    `;
  } else {
    listBody = providerAccounts
      .map((acc, idx) => {
        const switching = isSameKey(switchingKey, acc);
        const active = !switching && isSameKey(state.activeAccount, acc);
        const avatarText = computeAvatarText(acc);
        const isLoggedOut = acc.authState === "logged_out";
        const isGlados = acc.providerId === "glados";
        const hasDetail = !isLoggedOut && Boolean(acc.quotaDetail);

        const quotaState = isLoggedOut
          ? { status: "normal" as QuotaStatus, label: "", extraDepleted: false }
          : resolveQuotaState(acc);
        const {
          status: alertStatus,
          label: alertLabel,
          extraDepleted,
        } = quotaState;

        const isMac = navigator.userAgent.includes("Mac");
        const shortcutHint =
          idx < 9
            ? `<span class="shortcut-pill" title="快捷切号">${isMac ? "⌘" : "^"}${idx + 1}</span>`
            : "";
        const sessionBadgeHtml = isLoggedOut
          ? ""
          : acc.sessionState === "waiting"
            ? `<span class="session-badge waiting">待审批</span>`
            : acc.sessionState === "working"
              ? `<span class="session-badge working">工作中</span>`
              : acc.sessionState === "done"
                ? `<span class="session-badge done">已完成</span>`
                : "";

        const gladosExpired =
          isGlados &&
          !isLoggedOut &&
          typeof acc.gdLeftDays === "number" &&
          acc.gdLeftDays <= 0;
        const alertBadgeHtml = gladosExpired
            ? `<span class="quota-warning-badge critical">已过期</span>`
          : isLoggedOut
            ? `<span class="auth-status-badge">未登录</span>`
            : acc.quotaStale
            ? `<span class="quota-warning-badge stale" title="连续多次未抓到额度，页面结构可能已变化，当前显示的额度可能不准">抓取异常</span>`
            : acc.viewError
              ? `<span class="quota-warning-badge stale" title="该账号的保活视图预热失败，额度可能不刷新，点行尾的刷新按钮重试">视图异常</span>`
              : alertStatus !== "normal"
                ? `<span class="quota-warning-badge ${alertStatus}">${alertLabel}</span>`
                : "";

        const syncNoteHtml =
          !isLoggedOut &&
          !acc.quotaStale &&
          typeof acc.quotaSyncedAtMs === "number" &&
          Date.now() - acc.quotaSyncedAtMs > 30 * 60_000
            ? `<div class="account-sub quota-sync-note"><span class="quota-label-text">额度 ${Math.floor((Date.now() - acc.quotaSyncedAtMs) / 60_000)} 分钟前更新，可能已过期</span></div>`
            : "";

        let compactSubHtml = "";
        if (acc.pageError && !isLoggedOut) {
          compactSubHtml = `<div class="account-sub page-error"><span class="quota-label-text">状态异常：页面出错或被限制，可在上方待处理队列点「清理重登」</span></div>`;
        } else if (switching && !hasDetail) {
          compactSubHtml = `<div class="account-sub loading-text"><span class="quota-label-text">正在加载…</span></div>`;
        } else if (isGlados) {
          if (isLoggedOut) {
            compactSubHtml = `<div class="account-sub auth-logged-out"><span class="auth-dot-inline"></span><span class="quota-label-text">Cookie 已失效，点行尾钥匙按钮更新</span></div>`;
          } else {
            const d = acc.gdLeftDays;
            let daysLine: string;
            let daysClass = "account-sub";
            if (typeof d !== "number") {
              daysLine = "状态同步中…";
            } else if (d > 1) {
              daysLine = `剩余 ${Math.floor(d)} 天 · ${fmtDateMs(Date.now() + d * 86_400_000)} 到期`;
              if (d <= 5) daysClass = "account-sub quota-low";
            } else if (d > 0) {
              daysLine = `剩余不足 1 天 · 今天到期`;
              daysClass = "account-sub quota-low";
            } else {
              daysLine = `已过期 ${Math.ceil(-d)} 天 · ${fmtDateMs(Date.now() + d * 86_400_000)} 已到期`;
              daysClass = "account-sub quota-empty";
            }
            let pointsLine: string;
            let pointsClass = "account-sub";
            if (acc.gdError) {
              pointsLine = acc.gdError;
              pointsClass = "account-sub quota-empty";
            } else if (typeof acc.gdPoints === "number") {
              pointsLine = `${acc.gdPoints.toLocaleString()} 积分 · 连签 ${acc.gdStreak ?? 0} 天 · ${acc.gdDomain}`;
            } else if (typeof acc.gdSyncedAtMs === "number") {
              pointsLine = acc.gdDomain;
            } else {
              pointsLine = "状态同步中…";
            }
            compactSubHtml = `<div class="${daysClass}"><span class="quota-label-text">${escapeHtml(daysLine)}</span></div><div class="${pointsClass}"><span class="quota-label-text">${escapeHtml(pointsLine)}</span></div>`;
          }
        } else if (isLoggedOut) {
          const loginHint = active
            ? "登录已失效，请在右侧重新登录"
            : acc.autoAlias
              ? "尚未登录，点击前往登录"
              : "登录已失效，点击重新登录";
          compactSubHtml = `<div class="account-sub auth-logged-out"><span class="auth-dot-inline"></span><span class="quota-label-text">${loginHint}</span></div>`;
        } else if (!hasDetail) {
          const quotaLabel =
            acc.quotaText ?? (acc.autoAlias ? "登录后自动同步额度" : "正在同步额度明细…");
          const isEmpty =
            acc.quotaPercent === 0 || Boolean(acc.quotaText?.includes("用尽"));
          const isLow =
            !isEmpty &&
            ((typeof acc.quotaPercent === "number" && acc.quotaPercent <= 20) ||
              Boolean(acc.quotaText?.includes("偏低")));
          const subClass = isEmpty
            ? "account-sub quota-empty"
            : isLow
              ? "account-sub quota-low"
              : "account-sub";
          const barHtml =
            typeof acc.quotaPercent === "number"
              ? `<span class="mini-quota-track"><span class="mini-quota-fill ${isEmpty ? "empty" : isLow ? "low" : ""}" style="width:${Math.max(0, Math.min(100, acc.quotaPercent))}%"></span></span>`
              : "";
          compactSubHtml = `<div class="${subClass}">${barHtml}<span class="quota-label-text">${escapeHtml(quotaLabel)}</span></div>`;
        }

        const rowClass = [
          "account-row",
          hasDetail ? "has-detail" : "",
          active ? "active" : "",
          switching ? "switching" : "",
          isLoggedOut ? "logged-out" : "",
          alertStatus !== "normal" ? `alert-${alertStatus}` : "",
        ]
          .filter(Boolean)
          .join(" ");

        const avatarClass = [
          "avatar",
          acc.autoAlias ? "pending-identity" : acc.providerId,
        ].join(" ");

        const avatarNodeHtml = acc.avatarUrl
          ? `<div class="avatar has-photo"><img src="${escapeHtml(acc.avatarUrl)}" class="avatar-photo" alt="" draggable="false" /></div>`
          : `<div class="${avatarClass}">${escapeHtml(avatarText)}</div>`;

        const searchText = `${acc.alias} ${acc.note}`.toLowerCase();
        const searchHidden =
          accountSearchQuery.trim() !== "" &&
          !searchText.includes(accountSearchQuery.trim().toLowerCase());
        return `
          <div class="${rowClass}${accountSearchQuery.trim() === "" ? " drag-enabled" : ""}" data-switch-uuid="${escapeHtml(acc.uuid)}" data-search-text="${escapeHtml(searchText)}" ${searchHidden ? `style="display:none;"` : ""}>
            <div class="account-header">
              <div class="avatar-wrap">
                ${avatarNodeHtml}
                ${switching ? `<span class="avatar-spinner"></span>` : ""}
                ${active ? `<span class="status-dot ${isLoggedOut ? "offline" : ""}"></span>` : ""}
              </div>
              <div class="account-meta">
                <div class="account-alias-row">
                  <span class="account-alias">${escapeHtml(acc.alias)}</span>
                  ${shortcutHint}
                  ${sessionBadgeHtml}
                  ${alertBadgeHtml}
                </div>
                ${acc.note.trim() ? `<div class="account-note" title="${escapeHtml(acc.note)}">${escapeHtml(acc.note)}</div>` : ""}
                ${compactSubHtml}
                ${syncNoteHtml}
              </div>
              <div class="row-ops">
                ${acc.viewError && !isLoggedOut ? `<button class="action-icon-btn" data-retry-uuid="${escapeHtml(acc.uuid)}" title="视图预热失败，点此重试" type="button">${ICON_REFRESH}</button>` : ""}
                ${isGlados ? `<button class="action-icon-btn" data-update-cookie-uuid="${escapeHtml(acc.uuid)}" title="更新 Cookie" type="button">${ICON_KEY}</button>` : ""}
                <button class="action-icon-btn" data-browser-uuid="${escapeHtml(acc.uuid)}" title="在默认浏览器打开官网（独立会话，作备用入口）" type="button">${ICON_EXTERNAL}</button>
                <button class="action-icon-btn" data-rename-uuid="${escapeHtml(acc.uuid)}" title="修改备注" type="button">${ICON_EDIT}</button>
                <button class="action-icon-btn danger" data-remove-uuid="${escapeHtml(acc.uuid)}" title="从本机移除" type="button">${ICON_TRASH}</button>
              </div>
            </div>
            ${!isLoggedOut && acc.quotaDetail ? renderQuotaDetailPanel(acc.quotaDetail, alertStatus, extraDepleted) : ""}
          </div>
        `;
      })
      .join("");
  }

  return `
    <div class="column-header">
      <div class="provider-title-wrap">
        <span class="provider-title">${escapeHtml(provider.name)}</span>
        ${
          !provider.enabled
            ? `<span class="status-pill">${escapeHtml(provider.statusText)}</span>`
            : providerAccounts.length > 0
              ? `<span class="count-badge">${providerAccounts.length}</span>`
              : ""
        }
      </div>
      <div class="header-actions">${headerBtnHtml}</div>
    </div>
    <div class="provider-switch">${state.providers
      .filter((p) => p.enabled)
      .map(
        (p) =>
          `<button class="provider-chip ${p.id === provider.id ? "active" : ""}" data-provider="${escapeHtml(p.id)}" type="button">${renderProviderLogo(p.id, "chip-logo", p.shortName)}<span>${escapeHtml(p.shortName)}</span></button>`
      )
      .join("")}<button id="add-site-btn" class="provider-chip add-chip" type="button" title="添加自定义服务">＋</button>${
      provider.id.startsWith("custom:")
        ? `<button id="remove-site-btn" class="provider-chip remove-chip" type="button" title="删除此自定义服务">删除服务</button>`
        : ""
    }</div>
    ${noticeHtml}
    ${conflictsHtml}
    ${renderPendingQueue(state)}
    ${provider.id === "muse" ? renderChatSearch() : providerAccounts.length >= 5 ? `<div class="account-search-row"><input id="account-search-input" class="account-search" type="text" placeholder="搜索账号（别名 / 备注）" value="${escapeHtml(accountSearchQuery)}" /></div>` : ""}
    ${overviewHtml}
    <div class="account-list">${listBody}</div>
    <div class="column-footer">
      <span class="footer-brand"><img src="/logos/app-logo.svg" alt="" class="footer-brand-img" draggable="false" />叠号</span>
      <span class="footer-spacer"></span>
      <button id="group-panel-btn" class="footer-util-btn" title="多账号群聊协作" type="button"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg><span>群聊</span></button>
      <button id="notify-settings-btn" class="footer-util-btn" title="系统通知设置" type="button">${ICON_BELL}<span>通知</span></button>
      <button id="proxy-settings-btn" class="footer-util-btn ${state.proxyUrl ? "proxy-active" : ""}" title="${state.proxyUrl ? `代理：${escapeHtml(state.proxyUrl)}` : "代理设置"}" type="button">${ICON_PROXY}<span>代理</span>${state.proxyUrl ? `<span class="update-dot"></span>` : ""}</button>
      <button id="check-update-btn" class="footer-util-btn ${updateState.result?.hasUpdate ? "has-update" : ""}" title="${updateState.result?.hasUpdate ? `发现新版本 v${escapeHtml(updateState.result.latestVersion)}` : "检查更新"}" type="button">${ICON_UPDATE}<span>更新</span>${updateState.result?.hasUpdate ? `<span class="update-dot"></span>` : ""}</button>
    </div>
    ${renderModal(provider)}
  `;
}

function renderRightStage(state: ManagerSnapshot, provider: ProviderInfo): string {
  const switchingKey = effectiveSwitchingKey(state);
  const switchingAcc = switchingKey
    ? state.accounts.find(
        (a) => a.providerId === switchingKey.providerId && a.uuid === switchingKey.uuid
      )
    : undefined;

  if (switchingKey) {
    const targetName = switchingAcc?.alias ?? provider.shortName;
    return `
      <main class="right-placeholder">
        <div class="stage-card">
          <div class="stage-logo-orbit">
            <span class="stage-orbit-ring"></span>
            <div class="stage-logo-tile">${renderProviderLogo(provider.id)}</div>
          </div>
          <div class="placeholder-title">正在加载「${escapeHtml(targetName)}」</div>
          <div class="placeholder-desc">首次打开正在渲染 ${escapeHtml(provider.shortName)} 页面，加载完成后再次切换将瞬间直达…</div>
          <div class="progress-track"><div class="progress-bar"></div></div>
        </div>
      </main>
    `;
  }

  if (!provider.enabled) {
    return `
      <main class="right-placeholder">
        <div class="stage-card">
          <div class="stage-logo-tile">${renderProviderLogo(provider.id)}</div>
          <div class="placeholder-title">${escapeHtml(provider.name)} · 待接入</div>
          <div class="placeholder-desc">首版暂未启用应用内嵌会话。访问官网不会覆盖上次已打开的账号记录。</div>
          <button id="stage-open-site-btn" class="btn primary" type="button">打开 ${escapeHtml(provider.shortName)} 官网</button>
        </div>
      </main>
    `;
  }

  return `
    <main class="right-placeholder">
      <div class="stage-card">
        <div class="stage-logo-tile">${renderProviderLogo(provider.id)}</div>
        <div class="placeholder-title">${escapeHtml(provider.name)}</div>
        <div class="placeholder-desc">从左侧选择一个账号进入对话，或新建账号开启独立隔离登录。</div>
        <button id="stage-add-btn" class="btn primary" type="button">+ 新增 ${escapeHtml(provider.shortName)} 账号</button>
      </div>
    </main>
  `;
}

function formatChatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function renderChatSearch(): string {
  const q = chatSearchQuery.trim();
  let panel = "";
  if (chatSearchLoading) {
    panel = `<div class="chat-search-panel"><div class="chat-search-status">正在逐个账号搜索聊天记录，冷账号需要临时加载页面，请稍候…</div></div>`;
  } else if (chatSearchError) {
    panel = `<div class="chat-search-panel"><div class="chat-search-status">${escapeHtml(chatSearchError)}</div></div>`;
  } else if (chatSearchResult && q !== "") {
    const r = chatSearchResult;
    const status = `已搜 ${r.searchedCount} 个账号 · ${r.results.length} 条结果${
      r.cachedCount ? ` · ${r.cachedCount} 个账号走本地索引` : ""
    }${r.failedAliases.length ? ` · 未搜到：${r.failedAliases.join("、")}` : ""}`;
    const rows = r.results.map(chatHitRow).join("");
    panel = `<div class="chat-search-panel"><div class="chat-search-status">${escapeHtml(status)}</div>${
      rows || `<div class="chat-search-status">没有匹配的聊天记录</div>`
    }</div>`;
  } else if (q === "" && recentChats.length > 0) {
    panel = `<div class="chat-search-panel"><div class="chat-search-status">最近会话（全部账号）</div>${recentChats.map(chatHitRow).join("")}</div>`;
  }
  return `<div class="account-search-row"><input id="chat-search-input" class="account-search" type="text" placeholder="搜索全部账号的聊天记录" value="${escapeHtml(chatSearchQuery)}" />${panel}</div>`;
}

let recentChats: GlobalChatHit[] = [];
let recentChatsAt = 0;

async function refreshRecentChats(force = false): Promise<boolean> {
  if (!force && Date.now() - recentChatsAt < 60_000) return false;
  try {
    recentChats = await invoke<GlobalChatHit[]>("get_recent_chats", { limit: 12 });
    recentChatsAt = Date.now();
    return true;
  } catch {
    return false;
  }
}

function chatHitRow(h: GlobalChatHit): string {
  return `
      <button type="button" class="chat-hit" data-chat-uuid="${escapeHtml(h.uuid)}" data-chat-session="${escapeHtml(h.sessionId)}">
        <span class="chat-hit-alias">${escapeHtml(h.alias)}</span>
        <span class="chat-hit-main">
          <span class="chat-hit-title">${escapeHtml(h.title)}</span>
          ${h.preview ? `<span class="chat-hit-preview">${escapeHtml(h.preview)}</span>` : ""}
        </span>
        ${h.updatedAt ? `<span class="chat-hit-time">${escapeHtml(formatChatTime(h.updatedAt))}</span>` : ""}
      </button>`;
}

type PendingKind = "waiting" | "error" | "done" | "logged_out";

function pendingItemsOf(
  st: ManagerSnapshot
): { acc: AccountRecord; kind: PendingKind; label: string }[] {
  const items: { acc: AccountRecord; kind: PendingKind; label: string }[] = [];
  for (const acc of st.accounts) {
    if (acc.sessionState === "waiting" && acc.authState !== "logged_out")
      items.push({ acc, kind: "waiting", label: "等审批" });
    else if (acc.pageError && acc.authState !== "logged_out")
      items.push({ acc, kind: "error", label: "状态异常" });
    else if (acc.sessionState === "done")
      items.push({ acc, kind: "done", label: "已完成" });
    else if (acc.authState === "logged_out")
      items.push({ acc, kind: "logged_out", label: "登录过期" });
  }
  const order: Record<PendingKind, number> = { waiting: 0, error: 1, done: 2, logged_out: 3 };
  return items.sort((a, b) => order[a.kind] - order[b.kind]);
}

function providerShortName(st: ManagerSnapshot, id: string): string {
  return st.providers.find((p) => p.id === id)?.shortName ?? id;
}

function renderPendingQueue(st: ManagerSnapshot): string {
  const items = pendingItemsOf(st);
  if (!items.length) return "";
  const rows = items
    .map(
      ({ acc, kind, label }) => `
      <button type="button" class="queue-row queue-${kind}" data-queue-provider="${escapeHtml(acc.providerId)}" data-queue-uuid="${escapeHtml(acc.uuid)}">
        <span class="queue-badge">${label}</span>
        <span class="queue-alias">${escapeHtml(acc.alias)}</span>
        <span class="queue-provider">${escapeHtml(providerShortName(st, acc.providerId))}</span>
        ${kind === "waiting" && acc.pendingDetail ? `<span class="queue-detail">${escapeHtml(acc.pendingDetail)}</span>` : ""}
        ${kind === "error" ? `<span class="queue-action" data-reset="1">清理重登</span>` : ""}
      </button>`
    )
    .join("");
  return `<div class="pending-queue"><div class="pending-queue-title">待处理（${items.length}）</div>${rows}</div>`;
}

// ---------- Cmd+K 命令面板 ----------
interface PaletteItem {
  section: string;
  label: string;
  sub: string;
  run: () => Promise<void> | void;
}

const palette = { open: false, query: "", sel: 0 };
let paletteItems: PaletteItem[] = [];
let paletteRecent: GlobalChatHit[] = [];

function buildPaletteItems(st: ManagerSnapshot): PaletteItem[] {
  const q = palette.query.trim().toLowerCase();
  const match = (t: string) => !q || t.toLowerCase().includes(q);
  const items: PaletteItem[] = [];
  for (const { acc, kind, label } of pendingItemsOf(st)) {
    if (!match(`${acc.alias} ${label} ${acc.pendingDetail}`)) continue;
    items.push({
      section: "待处理",
      label: `${label} · ${acc.alias}`,
      sub: kind === "waiting" && acc.pendingDetail ? acc.pendingDetail : providerShortName(st, acc.providerId),
      run: async () => {
        closePalette();
        await callCommand("switch_account", { providerId: acc.providerId, uuid: acc.uuid });
      },
    });
  }
  const sorted = [...st.accounts].sort(
    (a, b) =>
      (a.providerId === st.selectedProviderId ? 0 : 1) -
      (b.providerId === st.selectedProviderId ? 0 : 1)
  );
  for (const acc of sorted) {
    if (!match(`${acc.alias} ${acc.note}`)) continue;
    items.push({
      section: "账号",
      label: acc.alias,
      sub: `${providerShortName(st, acc.providerId)}${isSameKey(st.activeAccount, acc) ? " · 当前" : ""}`,
      run: async () => {
        closePalette();
        await callCommand("switch_account", { providerId: acc.providerId, uuid: acc.uuid });
      },
    });
  }
  for (const h of paletteRecent) {
    if (!match(`${h.title} ${h.alias} ${h.preview}`)) continue;
    items.push({
      section: "会话",
      label: h.title,
      sub: `${h.alias}${h.updatedAt ? ` · ${formatChatTime(h.updatedAt)}` : ""}`,
      run: async () => {
        closePalette();
        await callCommand("open_global_chat", { providerId: "muse", uuid: h.uuid, sessionId: h.sessionId });
      },
    });
  }
  const actions: PaletteItem[] = [
    {
      section: "操作",
      label: "刷新全部额度",
      sub: "",
      run: async () => {
        closePalette();
        await callCommand("refresh_all_quotas");
      },
    },
    {
      section: "操作",
      label: "检查更新",
      sub: "",
      run: () => {
        closePalette();
        document.querySelector<HTMLElement>("#check-update-btn")?.click();
      },
    },
    {
      section: "操作",
      label: "发送测试通知",
      sub: "",
      run: async () => {
        closePalette();
        try {
          await invoke<string>("send_test_notification");
        } catch {
          /* 通知面板会显示状态 */
        }
      },
    },
  ];
  for (const a of actions) if (match(a.label)) items.push(a);
  return items;
}

function paletteListHtml(st: ManagerSnapshot): string {
  paletteItems = buildPaletteItems(st);
  if (palette.sel >= paletteItems.length)
    palette.sel = Math.max(0, paletteItems.length - 1);
  if (!paletteItems.length) return `<div class="palette-empty">没有匹配项</div>`;
  let lastSection = "";
  return paletteItems
    .map((it, i) => {
      const head =
        it.section !== lastSection
          ? `<div class="palette-section">${it.section}</div>`
          : "";
      lastSection = it.section;
      return `${head}<button type="button" class="palette-item ${i === palette.sel ? "selected" : ""}" data-palette-idx="${i}">
        <span class="palette-item-label">${escapeHtml(it.label)}</span>
        ${it.sub ? `<span class="palette-item-sub">${escapeHtml(it.sub)}</span>` : ""}
      </button>`;
    })
    .join("");
}

function renderPalette(st: ManagerSnapshot): string {
  return `<div class="palette-overlay" id="palette-overlay">
    <div class="palette-panel">
      <input id="palette-input" class="palette-input" type="text" placeholder="搜账号、会话，或输入操作…" value="${escapeHtml(palette.query)}" />
      <div class="palette-list" id="palette-list">${paletteListHtml(st)}</div>
      <div class="palette-hint">↑↓ 选择 · Enter 执行 · Esc 关闭</div>
    </div>
  </div>`;
}

function refreshPaletteListDom(): void {
  const el = document.getElementById("palette-list");
  if (el && snapshot) {
    el.innerHTML = paletteListHtml(snapshot);
    el.querySelector(".palette-item.selected")?.scrollIntoView({ block: "nearest" });
  }
}

function openPalette(): void {
  palette.open = true;
  palette.query = "";
  palette.sel = 0;
  render();
  void (async () => {
    try {
      paletteRecent = await invoke<GlobalChatHit[]>("get_recent_chats", { limit: 50 });
      if (palette.open) refreshPaletteListDom();
    } catch {
      /* 索引为空时会话区为空 */
    }
  })();
}

function closePalette(): void {
  palette.open = false;
  render();
}

async function runChatSearch(): Promise<void> {
  const q = chatSearchQuery.trim();
  if (q === "") {
    chatSearchResult = null;
    chatSearchError = "";
    render();
    return;
  }
  chatSearchLoading = true;
  chatSearchError = "";
  render();
  document.querySelector<HTMLInputElement>("#chat-search-input")?.focus();
  try {
    chatSearchResult = await invoke<GlobalSearchResult>("search_global_chats", { query: q });
  } catch (err) {
    chatSearchResult = null;
    chatSearchError = `搜索失败：${String(err)}`;
  } finally {
    chatSearchLoading = false;
    render();
    void refreshRecentChats(true);
  }
}

// ---------- 群聊协作面板 ----------

function currentGroup(): ChatGroupView | null {
  if (!groupData || !groupData.groups.length) return null;
  return groupData.groups.find((g) => g.id === currentGroupId) ?? groupData.groups[0];
}

function scrollGroupTranscript(): void {
  const el = document.querySelector<HTMLElement>("#group-transcript");
  if (el) el.scrollTop = el.scrollHeight;
}

function showGroupError(err: unknown): void {
  const st = document.querySelector<HTMLElement>(".group-status");
  if (st) st.textContent = String(err);
}

async function openGroupPanel(): Promise<void> {
  groupPanelOpen = true;
  try {
    snapshot = await invoke<ManagerSnapshot>("set_modal_active", { active: true });
  } catch {
    /* 忽略：面板照常打开 */
  }
  try {
    groupData = await invoke<GroupData>("get_group_data");
    if (!currentGroupId && groupData.groups.length) {
      currentGroupId = groupData.groups[0].id;
    }
  } catch {
    /* 忽略 */
  }
  render();
  scrollGroupTranscript();
  if (groupPollTimer !== null) window.clearInterval(groupPollTimer);
  groupPollTimer = window.setInterval(() => {
    void pollGroupData();
  }, 2500);
}

async function closeGroupPanel(): Promise<void> {
  groupPanelOpen = false;
  if (groupPollTimer !== null) {
    window.clearInterval(groupPollTimer);
    groupPollTimer = null;
  }
  try {
    snapshot = await invoke<ManagerSnapshot>("set_modal_active", { active: false });
  } catch {
    /* 忽略 */
  }
  render();
}

async function pollGroupData(): Promise<void> {
  if (!groupPanelOpen) return;
  const active = document.activeElement;
  if (
    active &&
    active.closest(".group-panel") &&
    (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT")
  ) {
    return;
  }
  try {
    const fresh = await invoke<GroupData>("get_group_data");
    if (JSON.stringify(fresh) !== JSON.stringify(groupData)) {
      groupData = fresh;
      render();
      scrollGroupTranscript();
    }
  } catch {
    /* 忽略 */
  }
}

function groupApiRowHtml(m: { id: string; name: string; baseUrl: string; model: string; hasKey: boolean }): string {
  return `<div class="group-api-row" data-api-row>
    <input class="modal-input g-api-name" placeholder="名称（如 DeepSeek）" value="${escapeHtml(m.name)}" data-api-id="${escapeHtml(m.id)}" />
    <input class="modal-input g-api-base" placeholder="接口地址 https://api.deepseek.com/v1" value="${escapeHtml(m.baseUrl)}" />
    <input class="modal-input g-api-model" placeholder="模型（如 deepseek-chat）" value="${escapeHtml(m.model)}" />
    <input class="modal-input g-api-key" type="password" placeholder="${m.hasKey ? "API Key 已设置（留空不改）" : "API Key"}" value="" />
  </div>`;
}

function renderGroupPanel(): string {
  const g = currentGroup();
  const head = `<div class="group-side-head"><span>群聊协作</span><span><button id="group-new-btn" class="mini-btn" type="button">+ 新建</button> <button id="group-close-btn" class="mini-btn" type="button">关闭</button></span></div>`;
  if (!g || !groupData) {
    return `<div class="group-panel"><div class="group-side">${head}<div class="group-empty">还没有群聊。点「+ 新建」创建一个，把多个 Muse 账号和外部 API 拉进同一个对话里协作。</div></div><div class="group-main"><div class="group-empty">新建群聊后，在左侧勾选成员、选协作模式，就能开始群聊。</div></div></div>`;
  }
  const gd = groupData;
  const groupsHtml = gd.groups
    .map(
      (gr) =>
        `<button type="button" class="group-item ${gr.id === g.id ? "active" : ""}" data-group-id="${escapeHtml(gr.id)}">${escapeHtml(gr.name)}${gd.runs[gr.id] ? `<span class="group-running-dot"></span>` : ""}</button>`
    )
    .join("");
  const museAccounts = (snapshot?.accounts ?? []).filter((a) => a.providerId === "muse");
  const memberChecks = museAccounts.length
    ? museAccounts
        .map((a) => {
          const checked = g.memberKeys.some((k) => k.uuid === a.uuid);
          return `<label class="group-member-row"><input type="checkbox" data-member-uuid="${escapeHtml(a.uuid)}" ${checked ? "checked" : ""} /> <span>${escapeHtml(a.alias)}</span>${a.authState === "logged_out" ? `<span class="group-member-note">未登录</span>` : ""}</label>`;
        })
        .join("")
    : `<div class="group-member-note">暂无 Muse 账号</div>`;
  const apiRows = g.apiMembers.map((m) => groupApiRowHtml(m)).join("");
  const phase = gd.runs[g.id];
  const transcript = g.transcript.length
    ? g.transcript
        .map((msg) => {
          if (msg.role === "user") {
            return `<div class="gmsg user"><div class="gmsg-author">我</div><div class="gmsg-text">${escapeHtml(msg.text)}</div></div>`;
          }
          if (msg.role === "system") {
            return `<div class="gmsg system"><div class="gmsg-text">${escapeHtml(msg.text)}</div></div>`;
          }
          return `<div class="gmsg member"><div class="gmsg-author">${escapeHtml(msg.author)}</div><div class="gmsg-text">${escapeHtml(msg.text)}</div></div>`;
        })
        .join("")
    : `<div class="group-empty">暂无消息。在下方输入问题，成员们会按所选模式作答。Muse 成员会在各自账号里真实开一个新对话来回答。</div>`;
  return `<div class="group-panel">
    <div class="group-side">
      ${head}
      <div class="group-list">${groupsHtml}</div>
      <div class="group-settings">
        <div class="group-set-title">群聊设置</div>
        <input id="g-name" class="modal-input" maxlength="30" value="${escapeHtml(g.name)}" placeholder="群聊名称" />
        <select id="g-mode" class="modal-input">
          <option value="parallel" ${g.mode === "parallel" ? "selected" : ""}>并行讨论（各自独立作答）</option>
          <option value="review" ${g.mode === "review" ? "selected" : ""}>评审流（先答后评）</option>
          <option value="relay" ${g.mode === "relay" ? "selected" : ""}>A2A 接力（依次承接完善）</option>
        </select>
        <div class="group-set-label">Muse 成员</div>
        ${memberChecks}
        <div class="group-set-label">API 成员（OpenAI 兼容）<button id="g-api-add" class="mini-btn" type="button">+ 添加一行</button></div>
        <div id="g-api-rows">${apiRows}</div>
        <div class="group-set-label">共享上下文（每轮随问题发给每位成员）</div>
        <textarea id="g-context" class="modal-input modal-textarea" rows="3" placeholder="如：回答请务实、简洁，给出可执行结论">${escapeHtml(g.sharedContext)}</textarea>
        <div class="group-set-actions">
          <button id="g-save" class="btn primary" type="button">保存设置</button>
          <button id="g-delete" class="btn danger" type="button">删除群聊</button>
        </div>
      </div>
    </div>
    <div class="group-main">
      <div class="group-status">${phase ? `<span class="group-phase-dot"></span>${escapeHtml(phase)}` : "就绪。@成员名 只问某位，@全体 问所有人；不 @ 默认问全体成员。"}</div>
      <div class="group-transcript" id="group-transcript">${transcript}</div>
      <div class="group-input-row">
        <textarea id="g-input" class="modal-input" rows="2" placeholder="输入消息，Enter 发送（Shift+Enter 换行）"></textarea>
        <button id="g-send" class="btn primary" type="button" ${phase ? "disabled" : ""}>发送</button>
      </div>
    </div>
  </div>`;
}

function bindGroupPanel(): void {
  document.querySelector("#group-close-btn")?.addEventListener("click", () => {
    void closeGroupPanel();
  });
  document.querySelector("#group-new-btn")?.addEventListener("click", async () => {
    try {
      groupData = await invoke<GroupData>("create_group", { name: "" });
      currentGroupId = groupData.groups[groupData.groups.length - 1]?.id ?? currentGroupId;
      render();
    } catch (err) {
      showGroupError(err);
    }
  });
  document.querySelectorAll<HTMLElement>("[data-group-id]").forEach((el) => {
    el.addEventListener("click", () => {
      currentGroupId = el.dataset.groupId ?? null;
      render();
      scrollGroupTranscript();
    });
  });
  document.querySelector("#g-api-add")?.addEventListener("click", () => {
    const rows = document.querySelector("#g-api-rows");
    if (rows) {
      rows.insertAdjacentHTML(
        "beforeend",
        groupApiRowHtml({ id: "", name: "", baseUrl: "", model: "", hasKey: false })
      );
      bindGroupPanelApiRemove();
    }
  });
  document.querySelector("#g-save")?.addEventListener("click", async () => {
    const g = currentGroup();
    if (!g) return;
    const name = document.querySelector<HTMLInputElement>("#g-name")?.value ?? g.name;
    const mode = document.querySelector<HTMLSelectElement>("#g-mode")?.value ?? "parallel";
    const memberKeys = Array.from(
      document.querySelectorAll<HTMLInputElement>("[data-member-uuid]")
    )
      .filter((c) => c.checked)
      .map((c) => ({ providerId: "muse", uuid: c.dataset.memberUuid ?? "" }));
    const apiMembers = Array.from(document.querySelectorAll<HTMLElement>("[data-api-row]"))
      .map((row) => {
        const nameEl = row.querySelector<HTMLInputElement>(".g-api-name");
        return {
          id: nameEl?.dataset.apiId ?? "",
          name: nameEl?.value ?? "",
          baseUrl: row.querySelector<HTMLInputElement>(".g-api-base")?.value ?? "",
          model: row.querySelector<HTMLInputElement>(".g-api-model")?.value ?? "",
          apiKey: row.querySelector<HTMLInputElement>(".g-api-key")?.value || null,
        };
      })
      .filter((m) => m.name.trim() || m.id);
    const sharedContext = document.querySelector<HTMLTextAreaElement>("#g-context")?.value ?? "";
    try {
      groupData = await invoke<GroupData>("save_group", {
        input: { id: g.id, name, memberKeys, apiMembers, mode, sharedContext },
      });
      render();
    } catch (err) {
      showGroupError(err);
    }
  });
  const deleteBtn = document.querySelector<HTMLButtonElement>("#g-delete");
  deleteBtn?.addEventListener("click", async () => {
    const g = currentGroup();
    if (!g) return;
    if (deleteBtn.dataset.armed !== "1") {
      deleteBtn.dataset.armed = "1";
      deleteBtn.textContent = "确认删除？";
      return;
    }
    try {
      groupData = await invoke<GroupData>("delete_group", { groupId: g.id });
      currentGroupId = groupData.groups[0]?.id ?? null;
      render();
    } catch (err) {
      showGroupError(err);
    }
  });
  const doSend = async () => {
    const g = currentGroup();
    if (!g) return;
    const input = document.querySelector<HTMLTextAreaElement>("#g-input");
    const text = (input?.value ?? "").trim();
    if (!text) return;
    try {
      groupData = await invoke<GroupData>("send_group_message", { groupId: g.id, text });
      render();
      scrollGroupTranscript();
    } catch (err) {
      showGroupError(err);
    }
  };
  document.querySelector("#g-send")?.addEventListener("click", doSend);
  document.querySelector<HTMLTextAreaElement>("#g-input")?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      void doSend();
    }
  });
}

function bindGroupPanelApiRemove(): void {
  /* 预留：API 行删除暂通过清空名称并保存实现 */
}

function render(): void {
  // 拖拽排序进行中不重渲染（否则后台快照会打断拖拽），拖拽结束后统一刷新。
  if (dragInProgress) return;
  const root = document.querySelector<HTMLElement>("#app");
  if (!root || !snapshot) return;

  const provider = currentProvider(snapshot);

    root.innerHTML = `
      <div class="desktop-shell">
        <section class="middle-column">
          ${renderMiddleContent(snapshot, provider)}
        </section>
        ${renderRightStage(snapshot, provider)}
      </div>
      ${palette.open ? renderPalette(snapshot) : ""}
      ${groupPanelOpen ? renderGroupPanel() : ""}
    `;

  bindEvents(snapshot, provider);
  if (palette.open) {
    const pi = document.querySelector<HTMLInputElement>("#palette-input");
    if (pi && document.activeElement !== pi) {
      pi.focus();
      pi.setSelectionRange(pi.value.length, pi.value.length);
    }
  }
}

function bindEvents(state: ManagerSnapshot, provider: ProviderInfo): void {
  const openOfficial = async () => {
    await callCommand("open_official_site", { providerId: provider.id });
  };
  document.querySelector("#open-site-btn")?.addEventListener("click", openOfficial);
  document.querySelector("#stage-open-site-btn")?.addEventListener("click", openOfficial);

  document.querySelector("#sync-all-btn")?.addEventListener("click", async () => {
    const btn = document.querySelector("#sync-all-btn");
    btn?.classList.add("spinning");
    try {
      await callCommand("refresh_all_quotas");
    } finally {
      setTimeout(() => btn?.classList.remove("spinning"), 650);
    }
  });

  document.querySelectorAll<HTMLElement>("[data-provider]").forEach((el) => {
    el.addEventListener("click", async () => {
      const pid = el.dataset.provider as ProviderId | undefined;
      if (pid && snapshot && pid !== snapshot.selectedProviderId) {
        await callCommand("select_provider", { providerId: pid });
      }
    });
  });

  const openAddModal = async () => {
    if (provider.id === "glados") {
      await setModal({ kind: "add-glados", domainDraft: "glados.cloud", cookieDraft: "" });
    } else {
      await setModal({ kind: "add", providerId: provider.id, draft: "", cookieDraft: "" });
    }
  };
  document.querySelector("#add-account-btn")?.addEventListener("click", openAddModal);
  document.querySelector("#add-site-btn")?.addEventListener("click", () => {
    void setModal({ kind: "add-site", nameDraft: "", urlDraft: "" });
  });
  document.querySelector("#remove-site-btn")?.addEventListener("click", () => {
    const prov = currentProvider(state);
    if (prov && prov.id.startsWith("custom:")) {
      void setModal({ kind: "remove-site", defId: prov.id.slice("custom:".length), name: prov.name });
    }
  });
  document.querySelector("#stage-add-btn")?.addEventListener("click", openAddModal);

  document.querySelector("#dismiss-notice-btn")?.addEventListener("click", async () => {
    await callCommand("dismiss_notice");
  });

  document.querySelector("#proxy-settings-btn")?.addEventListener("click", async () => {
    if (modal.kind !== "none") return;
    await setModal({ kind: "proxy", draft: state.proxyUrl ?? "", warmLimit: state.warmViewLimit === null ? "" : String(state.warmViewLimit), followSystem: state.proxyFollowSystem, autoApprove: state.autoApprove });
  });

  document.querySelector("#group-panel-btn")?.addEventListener("click", () => {
    void openGroupPanel();
  });
  if (groupPanelOpen) bindGroupPanel();
  document.querySelector("#notify-settings-btn")?.addEventListener("click", async () => {
    if (modal.kind !== "none") return;
    let status = "unknown";
    try {
      status = await invoke<string>("get_notification_status");
    } catch {
      /* 状态查询失败时按未知展示，测试按钮仍可验证投递 */
    }
    await setModal({ kind: "notify", status, testNote: "" });
  });

  document.querySelector("#notify-test-btn")?.addEventListener("click", async () => {
    if (modal.kind !== "notify") return;
    let note: string;
    try {
      const msg = await invoke<string>("send_test_notification");
      note = msg || "测试通知已发出，请看屏幕右上角或打开通知中心确认。";
    } catch (err) {
      note = String(err);
    }
    let status = modal.status;
    try {
      status = await invoke<string>("get_notification_status");
    } catch {
      /* 保持原状态展示 */
    }
    modal = { kind: "notify", status, testNote: note };
    rerenderPreservingScroll();
  });

  document.querySelector("#notify-open-settings-btn")?.addEventListener("click", async () => {
    try {
      await invoke("open_notification_settings");
    } catch {
      /* 打不开时用户可手动前往 系统设置 → 通知 */
    }
  });

  document.querySelector("#check-update-btn")?.addEventListener("click", async () => {
    if (modal.kind !== "none") return;
    await setModal({ kind: "update" });
    if (!updateState.result && !updateState.checking && !updateState.installing) {
      await runCheckForUpdates(false);
    }
  });

  document.querySelector("#update-recheck-btn")?.addEventListener("click", async () => {
    await runCheckForUpdates(false);
  });

  document.querySelector("#update-install-btn")?.addEventListener("click", async () => {
    await runDownloadAndInstall();
  });

  document.querySelector("#update-open-page-btn")?.addEventListener("click", async () => {
    const pageUrl = updateState.result?.releasePageUrl;
    if (!pageUrl) return;
    try {
      await invoke("open_external_url", { url: pageUrl });
    } catch (err) {
      updateState.error = String(err);
      rerenderPreservingScroll();
    }
  });

  document.querySelectorAll<HTMLElement>("[data-resolve-uuid]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const uuid = btn.dataset.resolveUuid;
      const keepProviderId = btn.dataset.resolveProvider;
      if (uuid && keepProviderId) {
        await callCommand("resolve_uuid_conflict", { keepProviderId, uuid });
      }
    });
  });

  const searchInput = document.querySelector<HTMLInputElement>("#account-search-input");
  searchInput?.addEventListener("input", () => {
    accountSearchQuery = searchInput.value;
    const q = accountSearchQuery.trim().toLowerCase();
    document.querySelectorAll<HTMLElement>("[data-search-text]").forEach((row) => {
      const text = row.dataset.searchText ?? "";
      row.style.display = q === "" || text.includes(q) ? "" : "none";
    });
  });

  document.querySelectorAll<HTMLElement>("[data-queue-uuid]").forEach((el) => {
    el.addEventListener("click", async (ev) => {
      const uuid = el.dataset.queueUuid;
      const providerId = el.dataset.queueProvider;
      if (!uuid || !providerId) return;
      if ((ev.target as HTMLElement).closest("[data-reset]")) {
        await callCommand("reset_account_session", { providerId, uuid });
        return;
      }
      await callCommand("switch_account", { providerId, uuid });
    });
  });

  const paletteInput = document.querySelector<HTMLInputElement>("#palette-input");
  paletteInput?.addEventListener("input", () => {
    palette.query = paletteInput.value;
    palette.sel = 0;
    refreshPaletteListDom();
  });
  paletteInput?.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const d = e.key === "ArrowDown" ? 1 : -1;
      palette.sel = Math.min(
        Math.max(0, palette.sel + d),
        Math.max(0, paletteItems.length - 1)
      );
      refreshPaletteListDom();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = paletteItems[palette.sel];
      if (it) void it.run();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closePalette();
    }
  });
  document.querySelector("#palette-list")?.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>("[data-palette-idx]");
    if (!btn) return;
    const it = paletteItems[Number(btn.dataset.paletteIdx)];
    if (it) void it.run();
  });
  document.querySelector("#palette-overlay")?.addEventListener("click", (ev) => {
    if (ev.target === ev.currentTarget) closePalette();
  });

  const chatInput = document.querySelector<HTMLInputElement>("#chat-search-input");
  chatInput?.addEventListener("focus", () => {
    void (async () => {
      const changed = await refreshRecentChats();
      if (
        changed &&
        chatSearchQuery.trim() === "" &&
        !chatSearchResult &&
        !chatSearchLoading
      ) {
        render();
        document.querySelector<HTMLInputElement>("#chat-search-input")?.focus();
      }
    })();
  });
  chatInput?.addEventListener("input", () => {
    chatSearchQuery = chatInput.value;
    window.clearTimeout(chatSearchTimer);
    if (chatSearchQuery.trim() === "") {
      chatSearchResult = null;
      chatSearchError = "";
      render();
      return;
    }
    chatSearchTimer = window.setTimeout(() => {
      void runChatSearch();
    }, 800);
  });
  chatInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      window.clearTimeout(chatSearchTimer);
      void runChatSearch();
    }
  });

  document.querySelectorAll<HTMLElement>("[data-chat-uuid]").forEach((el) => {
    el.addEventListener("click", async () => {
      const uuid = el.dataset.chatUuid;
      const sessionId = el.dataset.chatSession;
      if (uuid && sessionId) {
        await callCommand("open_global_chat", { providerId: "muse", uuid, sessionId });
      }
    });
  });

  document.querySelectorAll<HTMLElement>("[data-browser-uuid]").forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      await invoke("open_external_url", { url: provider.homepageUrl });
    });
  });

  document.querySelectorAll<HTMLElement>("[data-retry-uuid]").forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const uuid = btn.dataset.retryUuid;
      if (uuid) {
        await callCommand("retry_account_view", { providerId: provider.id, uuid });
      }
    });
  });

  // 拖拽排序（指针式实现）：按下账号行移动超过阈值进入拖拽，被拖行跟随指针，
  // 蓝线指示落点，松手后持久化。不走 HTML5 DnD——Tauri/WKWebView 里页面级
  // 拖放事件会被原生文件拖放处理拦截，drop 经常送达不了（v0.3.3 的故障）。
  document.querySelectorAll<HTMLElement>(".account-row[data-switch-uuid]").forEach((row) => {
    if (accountSearchQuery.trim() !== "") return;
    row.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (modal.kind !== "none" || state.conflicts.length > 0) return;
      if ((e.target as HTMLElement).closest("button, a, input, textarea, select")) return;
      const startUuid = row.dataset.switchUuid;
      if (!startUuid) return;
      const startY = e.clientY;
      let dragging = false;
      let targetUuid: string | null = null;
      let targetBefore = true;

      const clearIndicators = () => {
        document
          .querySelectorAll(".account-row.drop-before, .account-row.drop-after")
          .forEach((el) => el.classList.remove("drop-before", "drop-after"));
      };
      const onMove = (ev: PointerEvent) => {
        const dy = ev.clientY - startY;
        if (!dragging && Math.abs(dy) > 5) {
          dragging = true;
          dragInProgress = true;
          row.classList.add("dragging");
        }
        if (!dragging) return;
        ev.preventDefault();
        row.style.transform = `translateY(${dy}px)`;
        const rows = Array.from(
          document.querySelectorAll<HTMLElement>(".account-row[data-switch-uuid]")
        ).filter((el) => el !== row);
        clearIndicators();
        targetUuid = null;
        for (const el of rows) {
          const r = el.getBoundingClientRect();
          if (ev.clientY < r.top + r.height / 2) {
            targetUuid = el.dataset.switchUuid || null;
            targetBefore = true;
            el.classList.add("drop-before");
            break;
          }
        }
        if (!targetUuid && rows.length > 0) {
          const last = rows[rows.length - 1];
          targetUuid = last.dataset.switchUuid || null;
          targetBefore = false;
          last.classList.add("drop-after");
        }
      };
      const onUp = async () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        if (!dragging) return;
        suppressNextClick = true;
        window.setTimeout(() => {
          suppressNextClick = false;
        }, 80);
        const moving = startUuid;
        const tUuid = targetUuid;
        const tBefore = targetBefore;
        row.classList.remove("dragging");
        row.style.transform = "";
        clearIndicators();
        dragInProgress = false;
        if (!tUuid || tUuid === moving) {
          render();
          return;
        }
        const ids = state.accounts
          .filter((a) => a.providerId === provider.id)
          .map((a) => a.uuid);
        const from = ids.indexOf(moving);
        if (from < 0 || !ids.includes(tUuid)) {
          render();
          return;
        }
        ids.splice(from, 1);
        const to = ids.indexOf(tUuid);
        ids.splice(tBefore ? to : to + 1, 0, moving);
        await callCommand("reorder_accounts", { providerId: provider.id, orderedUuids: ids });
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    });
  });

  document.querySelectorAll<HTMLElement>("[data-update-cookie-uuid]").forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const uuid = btn.dataset.updateCookieUuid;
      const acc = state.accounts.find((a) => a.providerId === provider.id && a.uuid === uuid);
      if (acc) {
        await setModal({
          kind: "update-glados",
          account: acc,
          cookieDraft: "",
        });
      }
    });
  });

  document.querySelectorAll<HTMLElement>("[data-rename-uuid]").forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const uuid = btn.dataset.renameUuid;
      const acc = state.accounts.find((a) => a.providerId === provider.id && a.uuid === uuid);
      if (acc) {
        await setModal({
          kind: "rename",
          account: acc,
          draft: acc.autoAlias ? "" : acc.alias,
          noteDraft: acc.note,
        });
      }
    });
  });

  document.querySelectorAll<HTMLElement>("[data-remove-uuid]").forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const uuid = btn.dataset.removeUuid;
      const acc = state.accounts.find((a) => a.providerId === provider.id && a.uuid === uuid);
      if (acc) {
        await setModal({ kind: "remove", account: acc });
      }
    });
  });

  document.querySelectorAll<HTMLElement>("[data-switch-uuid]").forEach((row) => {
    row.addEventListener("click", async () => {
      if (suppressNextClick) {
        suppressNextClick = false;
        return;
      }
      if (modal.kind !== "none" || state.conflicts.length > 0) return;
      const uuid = row.dataset.switchUuid;
      if (!uuid) return;
      if (
        state.activeAccount?.providerId === provider.id &&
        state.activeAccount?.uuid === uuid
      ) {
        return;
      }
      const alreadyWarm = state.warmAccounts.some(
        (k) => k.providerId === provider.id && k.uuid === uuid
      );
      await callCommand(
        "switch_account",
        { providerId: provider.id, uuid },
        alreadyWarm ? null : { providerId: provider.id, uuid }
      );
    });
  });

  const proxyInput = document.querySelector<HTMLInputElement>("#modal-proxy-input");
  proxyInput?.addEventListener("input", () => {
    if (modal.kind === "proxy") {
      modal.draft = proxyInput.value;
    }
  });
  proxyInput?.addEventListener("keydown", async (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      document.querySelector<HTMLButtonElement>("#modal-confirm-btn")?.click();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      await setModal({ kind: "none" });
    }
  });

  const aliasInput = document.querySelector<HTMLInputElement>("#modal-alias-input");
  aliasInput?.addEventListener("input", () => {
    if (modal.kind === "add" || modal.kind === "rename") {
      modal.draft = aliasInput.value;
    }
  });

  const cookieInput = document.querySelector<HTMLTextAreaElement>("#modal-cookie-input");
  cookieInput?.addEventListener("input", () => {
    if (modal.kind === "add-glados" || modal.kind === "update-glados") {
      modal.cookieDraft = cookieInput.value;
    }
  });

  const importCookieInput = document.querySelector<HTMLTextAreaElement>("#modal-import-cookie");
  importCookieInput?.addEventListener("input", () => {
    if (modal.kind === "add") {
      modal.cookieDraft = importCookieInput.value;
    }
  });

  const domainSelect = document.querySelector<HTMLSelectElement>("#modal-domain-select");
  domainSelect?.addEventListener("change", () => {
    if (modal.kind === "add-glados") {
      modal.domainDraft = domainSelect.value;
    }
  });

  const noteInput = document.querySelector<HTMLInputElement>("#modal-note-input");
  noteInput?.addEventListener("input", () => {
    if (modal.kind === "rename") {
      modal.noteDraft = noteInput.value;
    }
  });
  aliasInput?.addEventListener("keydown", async (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      document.querySelector<HTMLButtonElement>("#modal-confirm-btn")?.click();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      await setModal({ kind: "none" });
    }
  });

  document.querySelector("#modal-cancel-btn")?.addEventListener("click", async () => {
    if (modal.kind === "update" && updateState.installing) return;
    await setModal({ kind: "none" });
  });

  document.querySelector("#modal-confirm-btn")?.addEventListener("click", async () => {
    const currentModal = modal;
    if (currentModal.kind === "add") {
      const alias = currentModal.draft.trim();
      await setModal({ kind: "none" });
      await callCommand("add_account", {
        providerId: currentModal.providerId,
        alias,
        importCookie: currentModal.cookieDraft.trim() || null,
      });
    } else if (currentModal.kind === "rename") {
      const alias = currentModal.draft.trim();
      if (!alias) return;
      const noteChanged = currentModal.noteDraft !== currentModal.account.note;
      const note = currentModal.noteDraft;
      await setModal({ kind: "none" });
      await callCommand("rename_account", {
        providerId: currentModal.account.providerId,
        uuid: currentModal.account.uuid,
        alias,
      });
      if (noteChanged) {
        await callCommand("set_account_note", {
          providerId: currentModal.account.providerId,
          uuid: currentModal.account.uuid,
          note,
        });
      }
    } else if (currentModal.kind === "add-glados") {
      const cookie = currentModal.cookieDraft.trim();
      if (!cookie) return;
      const domainSel = document.querySelector<HTMLSelectElement>("#modal-domain-select");
      const domain = domainSel ? domainSel.value : currentModal.domainDraft;
      await setModal({ kind: "none" });
      await callCommand("add_glados_account", { domain, cookie });
    } else if (currentModal.kind === "update-glados") {
      const cookie = currentModal.cookieDraft.trim();
      if (!cookie) return;
      const uuid = currentModal.account.uuid;
      await setModal({ kind: "none" });
      await callCommand("update_glados_cookie", { uuid, cookie });
    } else if (currentModal.kind === "add-site") {
      const nameEl = document.querySelector<HTMLInputElement>("#modal-site-name");
      const urlEl = document.querySelector<HTMLInputElement>("#modal-site-url");
      const name = (nameEl?.value ?? currentModal.nameDraft).trim();
      const url = (urlEl?.value ?? currentModal.urlDraft).trim();
      if (!name || !url) return;
      await setModal({ kind: "none" });
      await callCommand("add_custom_site", { name, entryUrl: url });
    } else if (currentModal.kind === "remove-site") {
      const defId = currentModal.defId;
      await setModal({ kind: "none" });
      await callCommand("remove_custom_site", { defId });
    } else if (currentModal.kind === "remove") {
      await setModal({ kind: "none" });
      await callCommand("remove_account", {
        providerId: currentModal.account.providerId,
        uuid: currentModal.account.uuid,
      });
    } else if (currentModal.kind === "proxy") {
      const proxyUrl = currentModal.draft.trim();
      const followEl = document.querySelector<HTMLInputElement>("#modal-proxy-follow");
      const followSystem = followEl ? followEl.checked : undefined;
      const warmInput = document.querySelector<HTMLInputElement>("#modal-warm-limit");
      let warmLimit: number | null | undefined;
      if (warmInput) {
        const raw = warmInput.value.trim();
        if (raw === "") {
          warmLimit = null;
        } else {
          const parsed = parseInt(raw, 10);
          warmLimit = Number.isNaN(parsed)
            ? undefined
            : Math.max(0, Math.min(32, parsed));
        }
      }
      await setModal({ kind: "none" });
      await callCommand("set_proxy_url", { proxyUrl });
      if (warmLimit !== undefined && warmLimit !== snapshot?.warmViewLimit) {
        await callCommand("set_warm_view_limit", { limit: warmLimit });
      }
      if (followSystem !== undefined && followSystem !== snapshot?.proxyFollowSystem) {
        await callCommand("set_proxy_follow_system", { enabled: followSystem });
      }
      const approveEl = document.querySelector<HTMLInputElement>("#modal-auto-approve");
      if (approveEl && approveEl.checked !== snapshot?.autoApprove) {
        await callCommand("set_auto_approve", { enabled: approveEl.checked });
      }
    }
  });
}

async function bootstrap(): Promise<void> {
  await listen<ManagerSnapshot>("manager-state-changed", (event) => {
    saveScrollPosition();
    snapshot = event.payload;
    if (snapshot.activeAccount || !snapshot.switchingAccount) {
      optimisticSwitching = null;
    }
    render();
    restoreScrollPosition();
  });

  await listen<UpdateProgressEvent>("update-progress", (event) => {
    const evt = event.payload;
    updateState.progress = evt;
    if (evt.stage === "error") {
      updateState.error = evt.message;
    }
    if (modal.kind !== "update") {
      return;
    }
    const barEl = document.querySelector<HTMLElement>("#update-progress-bar");
    const textEl = document.querySelector<HTMLElement>("#update-progress-text");
    const pctEl = document.querySelector<HTMLElement>("#update-progress-pct");
    if (barEl && textEl && pctEl && lastRenderedUpdateStage === evt.stage && evt.stage !== "error") {
      textEl.textContent = evt.message;
      pctEl.textContent = formatProgressSummary(evt);
      if (evt.percent === null) {
        barEl.classList.add("indeterminate");
        barEl.style.width = "";
      } else {
        barEl.classList.remove("indeterminate");
        barEl.style.width = `${Math.max(0, Math.min(100, evt.percent))}%`;
      }
      return;
    }
    lastRenderedUpdateStage = evt.stage;
    rerenderPreservingScroll();
  });

  window.addEventListener("keydown", async (ev) => {
    if (
      (ev.metaKey || ev.ctrlKey) &&
      !ev.shiftKey &&
      !ev.altKey &&
      ev.key.toLowerCase() === "k"
    ) {
      ev.preventDefault();
      if (palette.open) closePalette();
      else openPalette();
      return;
    }
    if (modal.kind !== "none") {
      if (
        ev.key === "Escape" &&
        modal.kind !== "add" &&
        modal.kind !== "rename" &&
        !(modal.kind === "update" && updateState.installing)
      ) {
        ev.preventDefault();
        await setModal({ kind: "none" });
      }
      return;
    }
    const target = ev.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable)
    ) {
      return;
    }
    if ((ev.metaKey || ev.ctrlKey) && !ev.shiftKey && !ev.altKey) {
      const digit = parseInt(ev.key, 10);
      if (!isNaN(digit) && digit >= 1 && digit <= 9) {
        ev.preventDefault();
        if (!snapshot) return;
        const providerAccounts = snapshot.accounts.filter(
          (a) => a.providerId === snapshot!.selectedProviderId
        );
        const targetAcc = providerAccounts[digit - 1];
        if (targetAcc && !isSameKey(snapshot.activeAccount, targetAcc)) {
          const alreadyWarm = snapshot.warmAccounts.some(
            (k) =>
              k.providerId === targetAcc.providerId && k.uuid === targetAcc.uuid
          );
          await callCommand(
            "switch_account",
            { providerId: targetAcc.providerId, uuid: targetAcc.uuid },
            alreadyWarm ? null : { providerId: targetAcc.providerId, uuid: targetAcc.uuid }
          );
        }
        return;
      }
      if (
        ev.key === "ArrowUp" ||
        ev.key === "ArrowDown" ||
        ev.key === "[" ||
        ev.key === "]"
      ) {
        ev.preventDefault();
        if (!snapshot) return;
        const providerAccounts = snapshot.accounts.filter(
          (a) => a.providerId === snapshot!.selectedProviderId
        );
        if (providerAccounts.length <= 1) return;
        const curIdx = providerAccounts.findIndex((a) =>
          isSameKey(snapshot!.activeAccount, a)
        );
        const delta = ev.key === "ArrowUp" || ev.key === "[" ? -1 : 1;
        const nextIdx =
          (curIdx + delta + providerAccounts.length) % providerAccounts.length;
        const targetAcc = providerAccounts[nextIdx];
        if (targetAcc && !isSameKey(snapshot.activeAccount, targetAcc)) {
          const alreadyWarm = snapshot.warmAccounts.some(
            (k) =>
              k.providerId === targetAcc.providerId && k.uuid === targetAcc.uuid
          );
          await callCommand(
            "switch_account",
            { providerId: targetAcc.providerId, uuid: targetAcc.uuid },
            alreadyWarm ? null : { providerId: targetAcc.providerId, uuid: targetAcc.uuid }
          );
        }
      }
    }
  });

  snapshot = await invoke<ManagerSnapshot>("get_manager_state");
  render();
  setTimeout(() => {
    void runCheckForUpdates(true);
  }, 3500);
}

void bootstrap();
