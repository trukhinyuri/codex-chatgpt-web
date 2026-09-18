/**
 * The CLIProxyAPI service on macOS: a LaunchAgent that runs the proxy binary this app ships.
 *
 * The binary travels inside the app (Contents/Resources/cliproxyapi), so the proxy updates and rolls
 * back together with the app. At launcher start, `sync` copies a changed binary into place and
 * restarts the agent; the bridge retries refused connections meanwhile, and app updates only
 * install while Codex is idle, so no turn sees the restart. An existing installation can be
 * adopted (its LaunchAgent is stopped and kept as a backup) and released again unchanged.
 */
import { createHash } from "node:crypto";
import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { atomicWriteFile } from "./config";
import { loopbackBaseUrl, readCliProxyConnection } from "./cliproxy";

export const SERVICE_LABEL = "com.codex-superpower.cliproxyapi";
export const DEFAULT_BUNDLE_DIR = "/Applications/Codex Web GPT.app/Contents/Resources/cliproxyapi";
const HEALTH_TIMEOUT_MS = 20_000;

export type Launchctl = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
export type HealthFetch = (request: Request) => Promise<Response>;

export interface ServiceState {
  version: 1;
  enabled: boolean;
  configPath: string;
  /** Present when an existing LaunchAgent was taken over; `release` restores it. */
  adoptedFrom?: { label: string; plistBackup: string };
}

export interface ServicePaths {
  root: string;
  binary: string;
  state: string;
  logs: string;
  backups: string;
  plist: string;
}

export function servicePaths(home: string, launchAgents = join(homedir(), "Library", "LaunchAgents")): ServicePaths {
  const root = join(home, "cliproxyapi");
  return {
    root,
    binary: join(root, "bin", "cli-proxy-api"),
    state: join(root, "service.json"),
    logs: join(root, "logs"),
    backups: join(root, "backups"),
    plist: join(launchAgents, `${SERVICE_LABEL}.plist`),
  };
}

export function readServiceState(paths: ServicePaths): ServiceState | null {
  if (!existsSync(paths.state)) return null;
  const parsed = JSON.parse(readFileSync(paths.state, "utf8")) as Partial<ServiceState>;
  if (parsed.version !== 1 || typeof parsed.configPath !== "string" || !isAbsolute(parsed.configPath)) {
    throw new Error(`${paths.state} is not a valid CLIProxyAPI service record`);
  }
  return { version: 1, enabled: parsed.enabled === true, configPath: parsed.configPath, ...(parsed.adoptedFrom ? { adoptedFrom: parsed.adoptedFrom } : {}) };
}

function writeServiceState(paths: ServicePaths, state: ServiceState): void {
  atomicWriteFile(paths.state, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function launchAgentPlist(paths: ServicePaths, configPath: string): string {
  const args = [paths.binary, "-config", configPath].map(arg => `    <string>${xml(arg)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(paths.root)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(join(paths.logs, "launchd.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(paths.logs, "launchd.err.log"))}</string>
</dict>
</plist>
`;
}

function sha256(file: string): string | null {
  return existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null;
}

interface BundleManifest {
  bundled: boolean;
  binary?: string;
  sha256?: string;
  proxyVersion?: string;
}

export function readBundle(bundleDir: string): (BundleManifest & { path: string }) | null {
  const manifestPath = join(bundleDir, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BundleManifest;
  if (!manifest.bundled || typeof manifest.binary !== "string" || basename(manifest.binary) !== manifest.binary) return null;
  const binary = join(bundleDir, manifest.binary);
  if (!existsSync(binary)) return null;
  if (manifest.sha256 && sha256(binary) !== manifest.sha256) throw new Error("The bundled CLIProxyAPI binary does not match its manifest");
  return { ...manifest, path: binary };
}

/** Where the proxy answers: the bridge's connection if set, otherwise host and port from its config. */
export function serviceBaseUrl(home: string, configPath: string): string {
  try {
    const connection = readCliProxyConnection(home);
    if (connection) return connection.baseUrl;
  } catch {}
  const text = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const port = /^port:\s*"?(\d{2,5})"?\s*$/m.exec(text)?.[1] ?? "8317";
  const host = /^host:\s*"?([^"\s#]+)"?/m.exec(text)?.[1] ?? "127.0.0.1";
  return loopbackBaseUrl(`http://${host === "" || host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`) ?? "http://127.0.0.1:8317";
}

async function waitHealthy(baseUrl: string, fetchImpl: HealthFetch, timeoutMs: number, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(new Request(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(3_000) }));
      if (response.ok) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

export interface ServiceDeps {
  home: string;
  uid: number;
  launchctl: Launchctl;
  fetchImpl?: HealthFetch;
  sleep?: (ms: number) => Promise<void>;
  launchAgents?: string;
  healthTimeoutMs?: number;
}

async function loaded(deps: ServiceDeps, label: string): Promise<boolean> {
  return (await deps.launchctl(["print", `gui/${deps.uid}/${label}`])).code === 0;
}

async function start(deps: ServiceDeps, paths: ServicePaths, restart: boolean): Promise<void> {
  if (!(await loaded(deps, SERVICE_LABEL))) {
    const result = await deps.launchctl(["bootstrap", `gui/${deps.uid}`, paths.plist]);
    if (result.code !== 0) throw new Error(`launchctl could not start CLIProxyAPI: ${result.stderr.trim() || `exit ${result.code}`}`);
  } else if (restart) {
    const result = await deps.launchctl(["kickstart", "-k", `gui/${deps.uid}/${SERVICE_LABEL}`]);
    if (result.code !== 0) throw new Error(`launchctl could not restart CLIProxyAPI: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
}

export interface SyncResult {
  status: "off" | "running" | "unhealthy";
  binaryChanged?: boolean;
  proxyVersion?: string | null;
  baseUrl?: string;
}

/**
 * Bring the service to the bundled binary. Nothing changes when the service is off; a missing
 * bundle keeps the installed binary. A changed binary replaces the old one by rename and restarts
 * the agent; the result says whether the proxy answered its health check afterwards.
 */
export async function syncService(deps: ServiceDeps, bundleDir = DEFAULT_BUNDLE_DIR): Promise<SyncResult> {
  const paths = servicePaths(deps.home, deps.launchAgents);
  const state = readServiceState(paths);
  if (!state?.enabled) return { status: "off" };
  const bundle = readBundle(bundleDir);
  let binaryChanged = false;
  if (bundle && sha256(bundle.path) !== sha256(paths.binary)) {
    mkdirSync(join(paths.root, "bin"), { recursive: true, mode: 0o700 });
    const next = `${paths.binary}.next`;
    copyFileSync(bundle.path, next);
    chmodSync(next, 0o755);
    renameSync(next, paths.binary);
    binaryChanged = true;
  }
  if (!existsSync(paths.binary)) throw new Error("CLIProxyAPI is not installed: this app does not carry its binary");
  mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
  const plist = launchAgentPlist(paths, state.configPath);
  const plistChanged = !existsSync(paths.plist) || readFileSync(paths.plist, "utf8") !== plist;
  if (plistChanged) {
    if (await loaded(deps, SERVICE_LABEL)) await deps.launchctl(["bootout", `gui/${deps.uid}/${SERVICE_LABEL}`]);
    mkdirSync(join(paths.plist, ".."), { recursive: true });
    atomicWriteFile(paths.plist, plist, { mode: 0o644, protectDirectory: false });
  }
  await start(deps, paths, binaryChanged && !plistChanged);
  const baseUrl = serviceBaseUrl(deps.home, state.configPath);
  const healthy = await waitHealthy(baseUrl, deps.fetchImpl ?? fetch, deps.healthTimeoutMs ?? HEALTH_TIMEOUT_MS, deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))));
  return { status: healthy ? "running" : "unhealthy", binaryChanged, proxyVersion: bundle?.proxyVersion ?? null, baseUrl };
}

/**
 * Take over a CLIProxyAPI that another LaunchAgent runs: stop it, keep its plist as a backup, and run
 * this app's binary with the same config. If the proxy does not come up, the old agent is restored.
 */
export async function adoptService(deps: ServiceDeps, configPath: string, existingLabel: string | null, bundleDir = DEFAULT_BUNDLE_DIR): Promise<SyncResult> {
  if (!isAbsolute(configPath) || !existsSync(configPath)) throw new Error("--config must name an existing CLIProxyAPI config file");
  if (existingLabel !== null && !/^[A-Za-z0-9._-]{1,128}$/.test(existingLabel)) throw new Error("Invalid LaunchAgent label");
  const paths = servicePaths(deps.home, deps.launchAgents);
  let adoptedFrom: ServiceState["adoptedFrom"];
  if (existingLabel && existingLabel !== SERVICE_LABEL) {
    const existingPlist = join(deps.launchAgents ?? join(homedir(), "Library", "LaunchAgents"), `${existingLabel}.plist`);
    if (!existsSync(existingPlist)) throw new Error(`No LaunchAgent ${existingLabel} to adopt`);
    mkdirSync(paths.backups, { recursive: true, mode: 0o700 });
    const plistBackup = join(paths.backups, `${existingLabel}.plist.${new Date().toISOString().replace(/[-:.]/g, "")}`);
    copyFileSync(existingPlist, plistBackup);
    if (await loaded(deps, existingLabel)) await deps.launchctl(["bootout", `gui/${deps.uid}/${existingLabel}`]);
    rmSync(existingPlist);
    adoptedFrom = { label: existingLabel, plistBackup };
  }
  writeServiceState(paths, { version: 1, enabled: true, configPath, ...(adoptedFrom ? { adoptedFrom } : {}) });
  try {
    const result = await syncService(deps, bundleDir);
    if (result.status !== "running") throw new Error("CLIProxyAPI did not answer its health check with this app's binary");
    return result;
  } catch (error) {
    await releaseService(deps).catch(() => undefined);
    throw error;
  }
}

/** Stop this app's agent and give an adopted installation its own LaunchAgent back. */
export async function releaseService(deps: ServiceDeps): Promise<{ released: true; restored: string | null }> {
  const paths = servicePaths(deps.home, deps.launchAgents);
  const state = readServiceState(paths);
  if (await loaded(deps, SERVICE_LABEL)) await deps.launchctl(["bootout", `gui/${deps.uid}/${SERVICE_LABEL}`]);
  rmSync(paths.plist, { force: true });
  let restored: string | null = null;
  if (state?.adoptedFrom && existsSync(state.adoptedFrom.plistBackup)) {
    const original = join(deps.launchAgents ?? join(homedir(), "Library", "LaunchAgents"), `${state.adoptedFrom.label}.plist`);
    copyFileSync(state.adoptedFrom.plistBackup, original);
    await deps.launchctl(["bootstrap", `gui/${deps.uid}`, original]);
    restored = state.adoptedFrom.label;
  }
  if (state) writeServiceState(paths, { ...state, enabled: false });
  return { released: true, restored };
}
