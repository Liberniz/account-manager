export type ProviderId = "muse" | "glados" | "cue";
export type AuthState = "unknown" | "authenticated" | "logged_out";

export interface AccountKey {
  providerId: ProviderId;
  uuid: string;
}

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  shortName: string;
  enabled: boolean;
  statusText: string;
  entryUrl: string;
  homepageUrl: string;
  callbackOrigins: string[];
  verifiedMethods: string[];
}

export interface QuotaDetail {
  planLabel: string;
  planValue: string;
  planSubtext: string | null;
  planUsedPercent: number | null;
  extraLabel: string | null;
  extraValue: string | null;
  extraSubtext: string | null;
  extraUsedPercent: number | null;
}

export interface AccountRecord {
  providerId: ProviderId;
  uuid: string;
  alias: string;
  createdAtMs: number;
  autoAlias: boolean;
  avatarUrl: string | null;
  quotaText: string | null;
  quotaPercent: number | null;
  quotaDetail: QuotaDetail | null;
  authState: AuthState;
  quotaSyncedAtMs: number | null;
  quotaStale: boolean;
  note: string;
  sessionState: string;
  pendingDetail: string;
  viewError: boolean;
  sortOrder: number;
  gdDomain: string;
  gdLeftDays: number | null;
  gdPoints: number | null;
  gdStreak: number | null;
  gdSyncedAtMs: number | null;
  gdError: string;
}

export interface ConflictItem {
  uuid: string;
  providers: ProviderId[];
}

export interface ManagerSnapshot {
  platform: string;
  providers: ProviderInfo[];
  accounts: AccountRecord[];
  selectedProviderId: ProviderId;
  activeAccount: AccountKey | null;
  switchingAccount: AccountKey | null;
  warmAccounts: AccountKey[];
  lastCommitted: AccountKey | null;
  pendingCleanup: AccountKey[];
  conflicts: ConflictItem[];
  notice: string | null;
  modalActive: boolean;
  proxyUrl: string | null;
  warmViewLimit: number | null;
  proxyFollowSystem: boolean;
  warmViewCount: number;
}

export interface GlobalChatHit {
  uuid: string;
  alias: string;
  sessionId: string;
  title: string;
  preview: string;
  updatedAt: string | null;
}

export interface GlobalSearchResult {
  results: GlobalChatHit[];
  searchedCount: number;
  cachedCount: number;
  failedAliases: string[];
}

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseNotes: string;
  pubDate: string | null;
  downloadUrl: string | null;
  sha256: string | null;
  filename: string | null;
  size: number | null;
  releasePageUrl: string;
}

export interface UpdateProgressEvent {
  stage: string;
  downloaded: number;
  total: number | null;
  percent: number | null;
  message: string;
}

export interface InstallUpdateOutcome {
  status: string;
  message: string;
}
