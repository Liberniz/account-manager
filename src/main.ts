import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./styles.css";
import type {
  AccountKey,
  AccountRecord,
  ManagerSnapshot,
  ProviderId,
  ProviderInfo,
} from "./types";

type ModalMode =
  | { kind: "none" }
  | { kind: "add"; providerId: ProviderId; draft: string }
  | { kind: "rename"; account: AccountRecord; draft: string }
  | { kind: "remove"; account: AccountRecord };

let snapshot: ManagerSnapshot | null = null;
let modal: ModalMode = { kind: "none" };
let busy = false;
const scrollOffsets: Record<ProviderId, number> = {
  muse: 0,
  hark: 0,
  cue: 0,
};

function isSameKey(a: AccountKey | null, b: AccountRecord): boolean {
  return Boolean(a && a.providerId === b.providerId && a.uuid === b.uuid);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
      alert(String(err));
    }
  }
  render();
  if (next.kind === "add" || next.kind === "rename") {
    const input = document.querySelector<HTMLInputElement>("#modal-alias-input");
    if (input) {
      input.focus();
      input.select();
    }
  } else if (next.kind === "remove") {
    const confirmBtn = document.querySelector<HTMLButtonElement>("#modal-confirm-btn");
    confirmBtn?.focus();
  }
}

async function callCommand(cmd: string, args: Record<string, unknown> = {}): Promise<void> {
  if (busy) return;
  busy = true;
  saveScrollPosition();
  try {
    snapshot = await invoke<ManagerSnapshot>(cmd, args);
  } catch (err) {
    if (snapshot) {
      snapshot = { ...snapshot, notice: String(err) };
    }
  } finally {
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

function renderModal(provider: ProviderInfo): string {
  if (modal.kind === "none") return "";
  if (modal.kind === "add") {
    return `
      <div class="inline-modal" role="dialog" aria-modal="true">
        <div class="modal-card">
          <div class="modal-title">新增 ${escapeHtml(provider.shortName)} 账号</div>
          <div class="modal-desc">将生成独立浏览资料并进入官方登录页，实际身份以官网显示为准。</div>
          <input id="modal-alias-input" class="modal-input" maxlength="40" placeholder="输入本地备注别名（如：工作 / 个人）" value="${escapeHtml(modal.draft)}" />
          <div class="modal-footer">
            <button id="modal-cancel-btn" class="btn" type="button">取消</button>
            <button id="modal-confirm-btn" class="btn primary" type="button">创建</button>
          </div>
        </div>
      </div>
    `;
  }
  if (modal.kind === "rename") {
    return `
      <div class="inline-modal" role="dialog" aria-modal="true">
        <div class="modal-card">
          <div class="modal-title">修改账号别名</div>
          <div class="modal-desc">仅更新本机列表识别名称，不影响已登录的官方会话。</div>
          <input id="modal-alias-input" class="modal-input" maxlength="40" value="${escapeHtml(modal.draft)}" />
          <div class="modal-footer">
            <button id="modal-cancel-btn" class="btn" type="button">取消</button>
            <button id="modal-confirm-btn" class="btn primary" type="button">保存</button>
          </div>
        </div>
      </div>
    `;
  }
  return `
    <div class="inline-modal" role="dialog" aria-modal="true">
      <div class="modal-card">
        <div class="modal-title">从本机移除「${escapeHtml(modal.account.alias)}」</div>
        <div class="modal-desc">将关闭该账号视图并清理本机独立浏览资料（Cookie、存储与缓存）。官方账号及云端对话仍由服务方保留。</div>
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
  const noticeHtml = state.notice
    ? `
      <div class="notice-bar">
        <span>${escapeHtml(state.notice)}</span>
        <button id="dismiss-notice-btn" class="notice-close" type="button">✕</button>
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
      <button id="open-site-btn" class="icon-btn" type="button">官网</button>
      <button id="add-account-btn" class="icon-btn primary" type="button">+ 新增</button>
    `
    : `<button id="open-site-btn" class="icon-btn primary" type="button">打开官网</button>`;

  let listBody = "";
  if (!provider.enabled) {
    listBody = `
      <div class="empty-list">
        <div><strong>${escapeHtml(provider.name)}</strong> 当前状态：${escapeHtml(provider.statusText)}</div>
        <div style="margin-top:8px;">浏览器直接完成登录并进入对话的官方路径与嵌入条款仍在核验中，可点击右上角访问官网。</div>
      </div>
    `;
  } else if (providerAccounts.length === 0) {
    listBody = `
      <div class="empty-list">
        暂无 ${escapeHtml(provider.shortName)} 账号<br />点击右上角「+ 新增」创建独立会话资料
      </div>
    `;
  } else {
    listBody = providerAccounts
      .map((acc) => {
        const active = isSameKey(state.activeAccount, acc);
        const switching = isSameKey(state.switchingAccount, acc);
        const initial = Array.from(acc.alias.trim())[0]?.toUpperCase() || "#";
        const statusLabel = switching
          ? "正在核验资料并打开…"
          : active
            ? "当前打开"
            : `ID · ${acc.uuid.slice(0, 8)}`;
        return `
          <div class="account-row ${active ? "active" : ""}" data-switch-uuid="${escapeHtml(acc.uuid)}">
            <div class="avatar ${escapeHtml(acc.providerId)}">${escapeHtml(initial)}</div>
            <div class="account-meta">
              <div class="account-alias">${escapeHtml(acc.alias)}</div>
              <div class="account-sub">${escapeHtml(statusLabel)}</div>
            </div>
            <div class="row-ops">
              <button class="mini-btn" data-rename-uuid="${escapeHtml(acc.uuid)}" type="button">改名</button>
              <button class="mini-btn danger" data-remove-uuid="${escapeHtml(acc.uuid)}" type="button">移除</button>
            </div>
          </div>
        `;
      })
      .join("");
  }

  return `
    <div class="column-header">
      <div class="provider-title-wrap">
        <span class="provider-title">${escapeHtml(provider.name)}</span>
        ${!provider.enabled ? `<span class="status-pill">${escapeHtml(provider.statusText)}</span>` : ""}
      </div>
      <div class="header-actions">${headerBtnHtml}</div>
    </div>
    ${noticeHtml}
    ${conflictsHtml}
    <div class="account-list">${listBody}</div>
    ${renderModal(provider)}
  `;
}

function render(): void {
  const root = document.querySelector<HTMLElement>("#app");
  if (!root || !snapshot) return;

  const provider = currentProvider(snapshot);
  const isAndroid = snapshot.platform === "android";

  if (isAndroid) {
    root.innerHTML = `
      <div class="mobile-shell">
        <div class="mobile-tabs">
          ${snapshot.providers
            .map(
              (p) => `
              <button class="mobile-tab ${p.id === provider.id ? "active" : ""}" data-provider="${escapeHtml(p.id)}" type="button">
                ${escapeHtml(p.shortName)}${!p.enabled ? " · 待接入" : ""}
              </button>
            `
            )
            .join("")}
        </div>
        <div class="middle-column" style="width:100%;min-width:0;flex:1;border-right:none;">
          ${renderMiddleContent(snapshot, provider)}
        </div>
      </div>
    `;
  } else {
    const rightDesc = !provider.enabled
      ? `${provider.name} 首版暂未开放应用内嵌，请通过官网或官方客户端使用。切换与访问官网不会覆盖上次已提交的账号记录。`
      : snapshot.switchingAccount
        ? "正在独立浏览资料中核对并加载官方页面…"
        : `从左侧列表选择一个 ${provider.shortName} 账号打开官方聊天页，或新增账号独立登录。`;

    root.innerHTML = `
      <div class="desktop-shell">
        <aside class="service-rail">
          ${snapshot.providers
            .map(
              (p) => `
              <button class="rail-btn ${p.id === provider.id ? "active" : ""}" data-provider="${escapeHtml(p.id)}" title="${escapeHtml(p.name)}" type="button">
                <span>${escapeHtml(p.shortName)}</span>
                ${!p.enabled ? `<span class="rail-badge">待接入</span>` : ""}
              </button>
            `
            )
            .join("")}
        </aside>
        <section class="middle-column">
          ${renderMiddleContent(snapshot, provider)}
        </section>
        <main class="right-placeholder">
          <div class="placeholder-title">${escapeHtml(provider.name)}</div>
          <div class="placeholder-desc">${escapeHtml(rightDesc)}</div>
        </main>
      </div>
    `;
  }

  bindEvents(snapshot, provider);
}

function bindEvents(state: ManagerSnapshot, provider: ProviderInfo): void {
  document.querySelectorAll<HTMLElement>("[data-provider]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const nextId = btn.dataset.provider as ProviderId;
      if (!nextId || nextId === state.selectedProviderId) return;
      if (modal.kind !== "none") {
        await setModal({ kind: "none" });
      }
      await callCommand("select_provider", { providerId: nextId });
    });
  });

  document.querySelector("#open-site-btn")?.addEventListener("click", async () => {
    await callCommand("open_official_site", { providerId: provider.id });
  });

  document.querySelector("#add-account-btn")?.addEventListener("click", async () => {
    await setModal({ kind: "add", providerId: provider.id, draft: "" });
  });

  document.querySelector("#dismiss-notice-btn")?.addEventListener("click", async () => {
    await callCommand("dismiss_notice");
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

  document.querySelectorAll<HTMLElement>("[data-rename-uuid]").forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const uuid = btn.dataset.renameUuid;
      const acc = state.accounts.find((a) => a.providerId === provider.id && a.uuid === uuid);
      if (acc) {
        await setModal({ kind: "rename", account: acc, draft: acc.alias });
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
      if (modal.kind !== "none" || state.conflicts.length > 0) return;
      const uuid = row.dataset.switchUuid;
      if (uuid) {
        await callCommand("switch_account", { providerId: provider.id, uuid });
      }
    });
  });

  const aliasInput = document.querySelector<HTMLInputElement>("#modal-alias-input");
  aliasInput?.addEventListener("input", () => {
    if (modal.kind === "add" || modal.kind === "rename") {
      modal.draft = aliasInput.value;
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
    await setModal({ kind: "none" });
  });

  document.querySelector("#modal-confirm-btn")?.addEventListener("click", async () => {
    const currentModal = modal;
    if (currentModal.kind === "add") {
      const alias = currentModal.draft.trim();
      if (!alias) return;
      await setModal({ kind: "none" });
      await callCommand("add_account", {
        providerId: currentModal.providerId,
        alias,
      });
    } else if (currentModal.kind === "rename") {
      const alias = currentModal.draft.trim();
      if (!alias) return;
      await setModal({ kind: "none" });
      await callCommand("rename_account", {
        providerId: currentModal.account.providerId,
        uuid: currentModal.account.uuid,
        alias,
      });
    } else if (currentModal.kind === "remove") {
      await setModal({ kind: "none" });
      await callCommand("remove_account", {
        providerId: currentModal.account.providerId,
        uuid: currentModal.account.uuid,
      });
    }
  });
}

async function bootstrap(): Promise<void> {
  await listen<ManagerSnapshot>("manager-state-changed", (event) => {
    saveScrollPosition();
    snapshot = event.payload;
    render();
    restoreScrollPosition();
  });

  snapshot = await invoke<ManagerSnapshot>("get_manager_state");
  render();
}

void bootstrap();
