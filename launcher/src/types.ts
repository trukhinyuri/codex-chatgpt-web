import languages from "../electron/languages.json";

export type Language = keyof typeof languages;
export type LauncherProfile = "production" | "development";
export type BrowserInteractionMode = "automatic" | "manual";
export type Surface = "browser" | "setup" | "mcp" | "cliproxy" | "activity" | "settings";

export interface LauncherState {
  version: 1;
  language: Language | null;
  onboardingComplete: boolean;
  githubOpened: boolean;
  xOpened: boolean;
  autoStart: boolean;
  keepRunningOnClose: boolean;
  showInMenuBar: boolean;
  automaticUpdates: boolean;
  showBrowserDuringTurns: boolean;
  browserInteractionMode: BrowserInteractionMode;
  experimentalBiggerContext: boolean;
  experimentalSkillAttachments: boolean;
  zeroRiskProEnabled: boolean;
  sidebarOpen: boolean;
  sidebarWidth: number;
  browserSmokePassed?: boolean;
  browserSmokeVersion?: string | null;
  coreSetupComplete?: boolean;
  codexCatalogVerified?: boolean;
  mcpSetupComplete?: boolean;
  mcpRuntimeInstalled?: boolean;
  codexRestartRequired?: boolean;
  mcpGuideStep: number;
  sessionRefreshReminderAt: string | null;
}

export interface BrowserState {
  status: "idle" | "loading" | "signed-out" | "ready" | "testing" | "running" | "error";
  message: string;
  url: string;
  title: string;
  authenticated: boolean;
  visible: boolean;
  surfaceActive: boolean;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  zoomFactor: number;
  activeTabId: string;
  maxTabs: number;
  tabs: BrowserTabState[];
}

export interface BrowserTabState {
  id: string;
  traceId: string | null;
  title: string;
  status: "idle" | "loading" | "signed-out" | "ready" | "testing" | "running" | "error" | "aborted";
  loading: boolean;
  active: boolean;
  closable: boolean;
  interactionMode?: BrowserInteractionMode;
  manualState?: "awaiting-user" | "sent" | "running" | "completed" | "timed-out" | "cancelled" | "failed";
  manualDeadlineAt?: string;
  canCopyPrompt?: boolean;
  canConfirmSent?: boolean;
}

export interface LogRecord {
  at: string;
  level: "debug" | "info" | "warning" | "error";
  event: string;
  detail: Record<string, unknown>;
}

export interface DoctorCheck {
  id: string;
  status: "ok" | "warning" | "error";
  message: string;
  detail?: string;
  unprovenLocally?: boolean;
}

export interface DoctorReport {
  ok: boolean;
  mode?: "browser-only" | "full";
  checks: DoctorCheck[];
  /** Runtime-produced reports include locally unproven checks; launcher-synthesized reports may not. */
  unproven?: string[];
}

export interface OperationState {
  name: string;
  status: "running" | "completed" | "failed";
  message: string;
}

export type UpdateState =
  | { status: "disabled" | "idle" | "checking" | "up-to-date" }
  | {
    status: "available" | "downloading" | "installing";
    version: string;
    /** This update may install by itself (fast-forward of main, CI passed, never failed here). */
    automatic?: boolean;
    blocked?: string;
    /** Built, tested and staged; waiting until Codex has no active turns. */
    waitingForIdle?: boolean;
    /** Build progress while status is "downloading". */
    step?: number;
    steps?: number;
    /** The user asked to install this update: it installs 30 s after Codex's tasks finish. */
    requested?: boolean;
    /** Codex tasks the staged update is waiting for. */
    activeTurns?: number;
  }
  | { status: "error"; message: string };

export interface LauncherSnapshot {
  profile: LauncherProfile;
  profilePaths: {
    coreHome: string;
    codexHome: string;
    userData: string;
  };
  state: LauncherState;
  browser: BrowserState | null;
  connectorName: string;
  connectorNames: Record<BrowserInteractionMode, string>;
  mcpCredentialsConfigured: boolean;
  logs: LogRecord[];
  urls: {
    github: string;
    x: string;
    connectors: string;
    tunnels: string;
    keys: string;
  };
  platform: string;
  packaged: boolean;
  version: string;
  smokePassed: boolean;
  operation: OperationState | null;
  update: UpdateState;
  /** Consent for GitHub problem reports; "unavailable" outside installed builds of this fork. */
  problemReports: ProblemReportConsent;
  /** macOS: Launch at login is on, but System Settings or MDM keep the LaunchAgent from running. */
  autostartBlocked?: boolean;
}

export type ProblemReportConsent = "unknown" | "auto" | "never" | "unavailable";

export interface CliProxyStatus {
  configured: boolean;
  enabled: boolean;
  baseUrl: string | null;
  reachable?: boolean;
  proxyModels?: number | null;
  error?: string;
  modelsInLastCodexCatalog: number | null;
}

export interface CliProxyAccount {
  /** Short reference used to remove the account; the file name may contain the e-mail. */
  ref: string;
  /** Masked like the label. */
  name: string;
  provider: string;
  /** E-mail addresses arrive masked. */
  label: string;
  disabled: boolean;
  status: string;
  coolingDown: boolean;
}

export const CLIPROXY_LOGIN_PROVIDERS = ["claude", "codex", "antigravity", "kimi", "xai", "devin", "meta"] as const;
export type CliProxyLoginProvider = (typeof CLIPROXY_LOGIN_PROVIDERS)[number];

export interface LauncherApi {
  snapshot(): Promise<LauncherSnapshot>;
  setLanguage(language: Language): Promise<LauncherState>;
  openSocial(target: "github" | "x"): Promise<LauncherState>;
  completeOnboarding(language: Language, browserInteractionMode: BrowserInteractionMode): Promise<LauncherState>;
  openExternal(url: string): Promise<boolean>;
  setBrowserBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<boolean>;
  setBrowserSurfaceActive(active: boolean): Promise<BrowserState>;
  showBrowser(): Promise<BrowserState>;
  hideBrowser(): Promise<BrowserState>;
  navigateBrowser(action: "back" | "forward" | "reload"): Promise<BrowserState>;
  zoomBrowser(action: "in" | "out" | "reset"): Promise<BrowserState>;
  selectBrowserTab(tabId: string): Promise<BrowserState>;
  closeBrowserTab(tabId: string): Promise<BrowserState>;
  copyManualPrompt(tabId: string): Promise<BrowserState>;
  confirmManualSent(tabId: string): Promise<BrowserState>;
  openLogin(): Promise<BrowserState>;
  openPasskeyLogin(): Promise<BrowserState>;
  continuePasskeyLogin(): Promise<boolean>;
  logoutChatGpt(): Promise<{ browser: BrowserState; state: LauncherState }>;
  dismissSessionReminder(): Promise<LauncherState>;
  smokeTest(): Promise<{ ok: boolean; effort: string; response: string }>;
  verifyMcp(): Promise<DoctorReport>;
  doctor(): Promise<DoctorReport>;
  cancelTurns(): Promise<{ stdout: string }>;
  uninstallIntegration(): Promise<{ cancelled: true } | { cancelled: false; state: LauncherState }>;
  setupCore(): Promise<{ ok: boolean; stdout: string; restartRequired: boolean }>;
  setupMcp(input: {
    tunnelId?: string;
    runtimeKey?: string;
    replace?: boolean;
    interactionMode?: BrowserInteractionMode;
  }): Promise<{ ok: boolean; stdout: string }>;
  setMcpStep(step: number): Promise<LauncherState>;
  setAutostart(enabled: boolean): Promise<{ state: LauncherState; supported: boolean; enabled: boolean; blocked?: boolean }>;
  setBiggerContext(enabled: boolean): Promise<LauncherState>;
  setSkillAttachments(enabled: boolean): Promise<LauncherState>;
  setZeroRiskPro(enabled: boolean): Promise<LauncherState>;
  setBrowserInteractionMode(mode: BrowserInteractionMode): Promise<{
    state: LauncherState;
    credentialsRequired: boolean;
    targetMode: BrowserInteractionMode;
  }>;
  setPreference(
    key: "keepRunningOnClose" | "showBrowserDuringTurns" | "automaticUpdates" | "showInMenuBar",
    value: boolean,
  ): Promise<LauncherState>;
  setSidebarState(state: { open: boolean; width: number }): Promise<LauncherState>;
  logs(limit?: number): Promise<LogRecord[]>;
  exportLogs(): Promise<string | null>;
  installUpdate(): Promise<boolean>;
  setProblemReports(enabled: boolean): Promise<ProblemReportConsent>;
  cliproxy(action: "status"): Promise<CliProxyStatus>;
  cliproxy(action: "connect", payload: { baseUrl: string; apiKey: string }): Promise<{ connected: true; proxyModels: number }>;
  cliproxy(action: "disconnect"): Promise<{ connected: false }>;
  cliproxy(action: "management-key", payload: string): Promise<{ management: true; accounts: number }>;
  cliproxy(action: "accounts"): Promise<{ accounts: CliProxyAccount[] }>;
  cliproxy(action: "login", payload: CliProxyLoginProvider): Promise<{ signedIn: true }>;
  cliproxy(action: "remove", payload: string): Promise<{ removed: string }>;
  windowState(): Promise<{ fullScreen: boolean; maximized: boolean }>;
  windowControl(action: "close" | "minimize" | "zoom"): void;
  onWindowStateChanged(listener: (state: { fullScreen: boolean; maximized: boolean }) => void): () => void;
  onStateChanged(listener: (state: LauncherState) => void): () => void;
  onBrowserState(listener: (state: BrowserState) => void): () => void;
  onOperation(listener: (state: OperationState) => void): () => void;
  onLog(listener: (record: LogRecord) => void): () => void;
  onUpdateState(listener: (state: UpdateState) => void): () => void;
}

declare global {
  interface Window {
    codexWebLauncher?: LauncherApi;
  }
}
