import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { atomicWriteFile, getConfigDir } from "./config";
import {
  CLIPROXY_CONNECTION_FILE,
  CLIPROXY_ROUTES_FILE,
  loopbackBaseUrl,
  readCliProxyConnection,
  type CliProxyFetch,
} from "./cliproxy";

export const CLIPROXY_HELP = `  codex-chatgpt-web cliproxy status
  codex-chatgpt-web cliproxy connect [--base-url URL] --api-key-stdin
  codex-chatgpt-web cliproxy disconnect`;

const DEFAULT_BASE_URL = "http://127.0.0.1:8317";

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

export async function cliproxyCommand(
  args: string[],
  { home = getConfigDir(), fetchImpl = fetch as CliProxyFetch, readKey = readStdin, write = (text: string) => { stdout.write(text); } } = {},
): Promise<void> {
  const action = args.shift() ?? "status";
  const connectionFile = join(home, CLIPROXY_CONNECTION_FILE);
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
  throw new Error("cliproxy action must be one of: status, connect, disconnect");
}
