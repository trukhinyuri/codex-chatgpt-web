import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { atomicWriteFile, getConfigDir } from "./config";
import {
  CLIPROXY_CONNECTION_FILE,
  CLIPROXY_ROUTES_FILE,
  loopbackBaseUrl,
  readCliProxyConnection,
  readCliProxyManagementKey,
  type CliProxyFetch,
} from "./cliproxy";

/** Providers CLIProxyAPI signs in with OAuth or a device code (management `<provider>-auth-url`). */
export const LOGIN_PROVIDERS = ["claude", "codex", "antigravity", "kimi", "xai", "devin", "meta"] as const;
const LOGIN_ROUTE: Record<(typeof LOGIN_PROVIDERS)[number], string> = {
  claude: "anthropic-auth-url",
  codex: "codex-auth-url",
  antigravity: "antigravity-auth-url",
  kimi: "kimi-auth-url",
  xai: "xai-auth-url",
  devin: "devin-auth-url",
  meta: "meta-auth-url",
};
export const CLIPROXY_HELP = `  codex-chatgpt-web cliproxy status
  codex-chatgpt-web cliproxy connect [--base-url URL] --api-key-stdin
  codex-chatgpt-web cliproxy disconnect
  codex-chatgpt-web cliproxy management-key --stdin
  codex-chatgpt-web cliproxy accounts [--show-emails]
  codex-chatgpt-web cliproxy login <${LOGIN_PROVIDERS.join("|")}> [--no-open]
  codex-chatgpt-web cliproxy remove REF`;

const DEFAULT_BASE_URL = "http://127.0.0.1:8317";
const LOGIN_TIMEOUT_MS = 5 * 60_000;

/** Accounts are listed for the person at the keyboard; an e-mail is masked unless asked for. */
export function maskEmail(value: string): string {
  return value.replace(/([A-Za-z0-9._%+-]{1,2})[A-Za-z0-9._%+-]*@/g, "$1***@");
}

export interface ProxyAccount {
  /** Stable short reference for `cliproxy remove`; account file names often contain the e-mail. */
  ref: string;
  name: string;
  provider: string;
  label: string;
  disabled: boolean;
  status: string;
  coolingDown: boolean;
}

export function accountRef(name: string): string {
  return createHash("sha256").update(name).digest("hex").slice(0, 10);
}

export function summarizeAccounts(payload: unknown, showEmails = false): ProxyAccount[] {
  const files = payload && typeof payload === "object" && Array.isArray((payload as { files?: unknown }).files)
    ? (payload as { files: Array<Record<string, unknown>> }).files
    : [];
  return files.map(file => {
    const label = String(file.label ?? file.email ?? file.name ?? "");
    const cooldowns = file.cooldowns;
    const name = String(file.name ?? "");
    return {
      ref: accountRef(name),
      name: showEmails ? name : maskEmail(name),
      provider: String(file.provider ?? file.type ?? "unknown"),
      label: showEmails ? label : maskEmail(label),
      disabled: file.disabled === true,
      status: String(file.status ?? (file.unavailable === true ? "unavailable" : "active")),
      coolingDown: Array.isArray(cooldowns) ? cooldowns.length > 0 : Boolean(cooldowns && typeof cooldowns === "object" && Object.keys(cooldowns).length > 0),
    };
  }).filter(account => account.name);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

interface Probe {
  reachable: boolean;
  models: number | null;
  error?: string;
}

/** Health without a key, then the Codex catalog with it. Never prints the key. */
export async function probeCliProxy(baseUrl: string, apiKey: string, fetchImpl: CliProxyFetch = fetch): Promise<Probe> {
  try {
    const health = await fetchImpl(new Request(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(5_000) }));
    if (!health.ok) return { reachable: false, models: null, error: `health check returned HTTP ${health.status}` };
  } catch (error) {
    return { reachable: false, models: null, error: error instanceof Error ? error.message : String(error) };
  }
  try {
    const response = await fetchImpl(new Request(`${baseUrl}/v1/models?client_version=0.0.0`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    }));
    if (response.status === 401 || response.status === 403) {
      return { reachable: true, models: null, error: "CLIProxyAPI rejected the API key" };
    }
    if (!response.ok) return { reachable: true, models: null, error: `model list returned HTTP ${response.status}` };
    const payload = await response.json() as { models?: unknown[] };
    return { reachable: true, models: Array.isArray(payload.models) ? payload.models.length : 0 };
  } catch (error) {
    return { reachable: true, models: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  args.splice(index, 2);
  return value;
}

function flag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function openInBrowser(url: string): void {
  if (process.platform === "darwin") Bun.spawn(["/usr/bin/open", url], { stdio: ["ignore", "ignore", "ignore"] });
}

export async function cliproxyCommand(
  args: string[],
  {
    home = getConfigDir(),
    fetchImpl = fetch as CliProxyFetch,
    readKey = readStdin,
    write = (text: string) => { stdout.write(text); },
    open = openInBrowser,
    sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
  } = {},
): Promise<void> {
  const action = args.shift() ?? "status";
  const connectionFile = join(home, CLIPROXY_CONNECTION_FILE);
  const management = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const connection = readCliProxyConnection(home);
    if (!connection) throw new Error("CLIProxyAPI is not connected; run `cliproxy connect` first");
    const key = readCliProxyManagementKey(home);
    if (!key) throw new Error("No CLIProxyAPI management key; run `cliproxy management-key --stdin` first");
    const response = await fetchImpl(new Request(`${connection.baseUrl}/v0/management/${path}`, {
      ...init,
      headers: { authorization: `Bearer ${key}`, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(30_000),
    }));
    if (response.status === 401 || response.status === 403) throw new Error("CLIProxyAPI rejected the management key");
    if (response.status === 404) throw new Error("CLIProxyAPI's management API is off; set remote-management.secret-key in its config");
    return response;
  };
  if (action === "status") {
    if (args.length > 0) throw new Error(`Unexpected argument: ${args[0]}`);
    const connection = readCliProxyConnection(home);
    let routed: number | null = null;
    try {
      routed = (JSON.parse(readFileSync(join(home, CLIPROXY_ROUTES_FILE), "utf8")) as { proxy?: unknown[] }).proxy?.length ?? 0;
    } catch {}
    const probe = connection ? await probeCliProxy(connection.baseUrl, connection.apiKey, fetchImpl) : null;
    write(`${JSON.stringify({
      configured: existsSync(connectionFile),
      enabled: connection !== null,
      baseUrl: connection?.baseUrl ?? null,
      ...(probe ? { reachable: probe.reachable, proxyModels: probe.models, ...(probe.error ? { error: probe.error } : {}) } : {}),
      modelsInLastCodexCatalog: routed,
    }, null, 2)}\n`);
    return;
  }
  if (action === "connect") {
    const baseUrl = loopbackBaseUrl(option(args, "--base-url") ?? DEFAULT_BASE_URL);
    if (!baseUrl) throw new Error("--base-url must be a CLIProxyAPI address on this machine (127.0.0.1, localhost or [::1])");
    if (!flag(args, "--api-key-stdin")) {
      throw new Error("Pass the CLIProxyAPI client API key on standard input with --api-key-stdin; it is never accepted as an argument");
    }
    if (args.length > 0) throw new Error(`Unexpected argument: ${args[0]}`);
    const apiKey = (await readKey()).trim();
    if (!apiKey || /\s/.test(apiKey) || apiKey.length > 512) throw new Error("Standard input must contain exactly one API key");
    const probe = await probeCliProxy(baseUrl, apiKey, fetchImpl);
    if (probe.models === null) throw new Error(`CLIProxyAPI at ${baseUrl} is not usable: ${probe.error ?? "unknown error"}`);
    const keyFile = join(home, "secrets", "cliproxy-api-key");
    atomicWriteFile(keyFile, `${apiKey}\n`, { mode: 0o600 });
    atomicWriteFile(connectionFile, `${JSON.stringify({ version: 1, enabled: true, baseUrl, apiKeyFile: keyFile }, null, 2)}\n`, { mode: 0o600 });
    write(`${JSON.stringify({
      connected: true,
      baseUrl,
      proxyModels: probe.models,
      note: "Codex lists the proxy's models at its next model refresh; restart Codex to see them now.",
    }, null, 2)}\n`);
    return;
  }
  if (action === "disconnect") {
    if (args.length > 0) throw new Error(`Unexpected argument: ${args[0]}`);
    if (!existsSync(connectionFile)) {
      write(`${JSON.stringify({ connected: false }, null, 2)}\n`);
      return;
    }
    const current = JSON.parse(readFileSync(connectionFile, "utf8")) as Record<string, unknown>;
    atomicWriteFile(connectionFile, `${JSON.stringify({ ...current, enabled: false }, null, 2)}\n`, { mode: 0o600 });
    write(`${JSON.stringify({ connected: false, note: "Proxy models leave the Codex catalog at its next refresh." }, null, 2)}\n`);
    return;
  }
  if (action === "management-key") {
    if (!flag(args, "--stdin")) throw new Error("Pass the management key on standard input with --stdin; it is never accepted as an argument");
    if (args.length > 0) throw new Error(`Unexpected argument: ${args[0]}`);
    if (!existsSync(connectionFile)) throw new Error("CLIProxyAPI is not connected; run `cliproxy connect` first");
    const key = (await readKey()).trim();
    if (!key || /\s/.test(key) || key.length > 512) throw new Error("Standard input must contain exactly one management key");
    const keyFile = join(home, "secrets", "cliproxy-management-key");
    const current = JSON.parse(readFileSync(connectionFile, "utf8")) as Record<string, unknown>;
    const previousKeyFile = typeof current.managementKeyFile === "string" ? current.managementKeyFile : null;
    atomicWriteFile(keyFile, `${key}\n`, { mode: 0o600 });
    atomicWriteFile(connectionFile, `${JSON.stringify({ ...current, managementKeyFile: keyFile }, null, 2)}\n`, { mode: 0o600 });
    try {
      const response = await management("auth-files");
      if (!response.ok) throw new Error(`the account list returned HTTP ${response.status}`);
      write(`${JSON.stringify({ management: true, accounts: summarizeAccounts(await response.json()).length }, null, 2)}\n`);
    } catch (error) {
      atomicWriteFile(connectionFile, `${JSON.stringify({ ...current, managementKeyFile: previousKeyFile ?? undefined }, null, 2)}\n`, { mode: 0o600 });
      throw error;
    }
    return;
  }
  if (action === "accounts") {
    const showEmails = flag(args, "--show-emails");
    if (args.length > 0) throw new Error(`Unexpected argument: ${args[0]}`);
    const response = await management("auth-files");
    if (!response.ok) throw new Error(`CLIProxyAPI account list returned HTTP ${response.status}`);
    write(`${JSON.stringify({ accounts: summarizeAccounts(await response.json(), showEmails) }, null, 2)}\n`);
    return;
  }
  if (action === "login") {
    const noOpen = flag(args, "--no-open");
    const provider = args.shift() as (typeof LOGIN_PROVIDERS)[number] | undefined;
    if (!provider || !LOGIN_PROVIDERS.includes(provider)) throw new Error(`cliproxy login needs one of: ${LOGIN_PROVIDERS.join(", ")}`);
    if (args.length > 0) throw new Error(`Unexpected argument: ${args[0]}`);
    const started = await management(`${LOGIN_ROUTE[provider]}?is_webui=true`);
    const session = await started.json() as { url?: unknown; state?: unknown; user_code?: unknown; flow?: unknown };
    if (!started.ok || typeof session.url !== "string" || typeof session.state !== "string") {
      throw new Error(`CLIProxyAPI could not start the ${provider} sign-in (HTTP ${started.status})`);
    }
    // The first line lets a caller (the launcher, an agent) open the page itself.
    write(`${JSON.stringify({ provider, url: session.url, ...(typeof session.user_code === "string" ? { userCode: session.user_code } : {}), waiting: true })}\n`);
    if (!noOpen) open(session.url);
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(2_000);
      const polled = await management(`get-auth-status?state=${encodeURIComponent(session.state)}`);
      const status = await polled.json() as { status?: unknown; error?: unknown };
      if (status.status === "ok") {
        write(`${JSON.stringify({ provider, signedIn: true })}\n`);
        return;
      }
      if (status.status === "error") throw new Error(`${provider} sign-in failed: ${String(status.error ?? "unknown error").slice(0, 200)}`);
    }
    await management(`oauth-session?state=${encodeURIComponent(session.state)}`, { method: "DELETE" }).catch(() => undefined);
    throw new Error(`${provider} sign-in did not finish within five minutes`);
  }
  if (action === "remove") {
    const wanted = args.shift();
    if (!wanted || args.length > 0) throw new Error("cliproxy remove needs exactly one account ref or name (see `cliproxy accounts`)");
    const listed = await management("auth-files");
    if (!listed.ok) throw new Error(`CLIProxyAPI account list returned HTTP ${listed.status}`);
    const names = summarizeAccounts(await listed.json(), true).map(account => account.name);
    const name = names.find(candidate => candidate === wanted || accountRef(candidate) === wanted);
    if (!name) throw new Error("No such CLIProxyAPI account; use a ref from `cliproxy accounts`");
    const response = await management(`auth-files?name=${encodeURIComponent(name)}`, { method: "DELETE" });
    if (!response.ok) throw new Error(`CLIProxyAPI could not remove the account (HTTP ${response.status})`);
    write(`${JSON.stringify({ removed: accountRef(name) }, null, 2)}\n`);
    return;
  }
  throw new Error("cliproxy action must be one of: status, connect, disconnect, management-key, accounts, login, remove");
}
