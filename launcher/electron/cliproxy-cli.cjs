const { spawn } = require("node:child_process");

// The launcher's CLIProxyAPI panel drives the runtime's `cliproxy` command, the same one agents
// use, so both paths share one implementation. Keys travel on standard input only, and nothing the
// command prints (account labels included) is written to the launcher log.
const CLI_ERROR_PREFIX = "codex-chatgpt-web: ";
const LOGIN_TIMEOUT_MS = 6 * 60_000;
const PROVIDERS = new Set(["claude", "codex", "antigravity", "kimi", "xai", "devin", "meta"]);

function parseJsonDocuments(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    return [JSON.parse(trimmed)];
  } catch {
    // `cliproxy login` prints one JSON object per line.
    return trimmed.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  }
}

function cliError(stderr, code) {
  const line = stderr.split(/\r?\n/).map(value => value.trim()).filter(Boolean).at(-1) || `cliproxy exited with code ${code}`;
  return new Error(line.startsWith(CLI_ERROR_PREFIX) ? line.slice(CLI_ERROR_PREFIX.length) : line);
}

/**
 * Run `codex-chatgpt-web cliproxy …`. `invocation` comes from RuntimeSupervisor.runtimeCommand;
 * `onLine` sees each stdout line as it arrives (login reports the sign-in URL before it waits).
 */
function runCliProxy(invocation, { env = process.env, input = null, timeoutMs = 60_000, onLine, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      env,
      stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let pending = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      pending += text;
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line && onLine) {
          try { onLine(JSON.parse(line)); } catch {}
        }
        newline = pending.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    if (input !== null) child.stdin.end(input);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(cliError(stderr, code));
        return;
      }
      try {
        const documents = parseJsonDocuments(stdout);
        resolve(documents.length === 1 ? documents[0] : documents);
      } catch {
        reject(new Error("cliproxy printed output the launcher could not read"));
      }
    });
  });
}

/** Operations the panel offers; each validates its own input before anything runs. */
function createCliProxyPanel({ invocationFor, env, openExternal }) {
  const run = (args, options) => runCliProxy(invocationFor(["cliproxy", ...args]), { env, ...options });
  const key = (value, label) => {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text || /\s/.test(text) || text.length > 512) throw new Error(`Enter the ${label}`);
    return `${text}\n`;
  };
  return {
    status: () => run(["status"]),
    connect({ baseUrl, apiKey }) {
      const url = typeof baseUrl === "string" && baseUrl.trim() ? baseUrl.trim() : "http://127.0.0.1:8317";
      return run(["connect", "--base-url", url, "--api-key-stdin"], { input: key(apiKey, "CLIProxyAPI API key"), timeoutMs: 30_000 });
    },
    disconnect: () => run(["disconnect"]),
    setManagementKey: value => run(["management-key", "--stdin"], { input: key(value, "CLIProxyAPI management key"), timeoutMs: 30_000 }),
    accounts: () => run(["accounts"]),
    remove(name) {
      if (typeof name !== "string" || !name.trim() || name.length > 512) throw new Error("Choose an account to remove");
      return run(["remove", name]);
    },
    login(provider) {
      if (!PROVIDERS.has(provider)) throw new Error(`Unknown CLIProxyAPI provider: ${provider}`);
      return run(["login", provider, "--no-open"], {
        timeoutMs: LOGIN_TIMEOUT_MS,
        onLine: (line) => {
          // The launcher opens the provider's own sign-in page in the default browser.
          if (typeof line?.url === "string" && /^https:\/\//.test(line.url)) void openExternal(line.url);
        },
      }).then(result => (Array.isArray(result) ? result.at(-1) : result));
    },
  };
}

module.exports = { createCliProxyPanel, runCliProxy };
