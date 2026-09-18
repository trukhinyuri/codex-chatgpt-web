// Build inputs of the CLIProxyAPI component that do not live in this repository, fetched from their
// official sources, pinned by version and SHA-256 in cliproxyapi-build.json, and cached per user:
//
// - the Go toolchain (go.dev), so every Mac builds the proxy with the same compiler and nobody has
//   to install Go;
// - the OAuth client of the public Antigravity desktop app, which upstream CLIProxyAPI embeds in
//   its source. It is read from upstream at a pinned commit and passed to the Go linker, so it never
//   sits in this repository.
//
// A network failure is reported with "[transient]" in the message: the launcher's updater then
// retries later instead of rejecting the commit. A checksum mismatch is never transient.
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MANIFEST = require("./cliproxyapi-build.json");
const ANTIGRAVITY_PACKAGE = "github.com/router-for-me/CLIProxyAPI/v7/internal/auth/antigravity";
const EMBEDDED_CLIENT_PATTERN = /GOCSPX-[A-Za-z0-9_-]{10,}|[0-9]{6,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com/;

function transientError(message, cause) {
  return Object.assign(new Error(`[transient] ${message}`), { transient: true, cause });
}

/** Per-user cache for the toolchain, Go's module and build caches, and the fetched client. */
function cacheRoot(env = process.env, platform = process.platform, home = os.homedir()) {
  const explicit = env.CODEX_SUPERPOWER_CACHE?.trim();
  if (explicit) return path.resolve(explicit);
  if (platform === "darwin") return path.join(home, "Library", "Caches", "codex-superpower");
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "codex-superpower", "cache");
  return path.join(env.XDG_CACHE_HOME || path.join(home, ".cache"), "codex-superpower");
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function fetchBytes(url, { fetchImpl = globalThis.fetch, what } = {}) {
  let response;
  try {
    response = await fetchImpl(url, { redirect: "follow" });
  } catch (error) {
    throw transientError(`could not download ${what}: ${error instanceof Error ? error.message : String(error)}`, error);
  }
  if (!response.ok) {
    const message = `could not download ${what}: HTTP ${response.status}`;
    if (response.status >= 500 || response.status === 429 || response.status === 408) throw transientError(message);
    throw new Error(message);
  }
  try {
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw transientError(`the download of ${what} was interrupted`, error);
  }
}

function verified(buffer, expected, what) {
  const actual = sha256(buffer);
  if (actual !== expected) throw new Error(`${what} does not match its pinned SHA-256 (expected ${expected}, got ${actual})`);
  return buffer;
}

function goVersionOf(go, env = process.env) {
  const result = spawnSync(go, ["version"], { encoding: "utf8", env: { ...env, GOTOOLCHAIN: "local" } });
  if (result.status !== 0) return null;
  const match = /\bgo(\d+\.\d+(?:\.\d+)?)\b/.exec(result.stdout);
  return match ? match[1] : null;
}

/**
 * The Go toolchain for the component: CODEX_SUPERPOWER_GO when set (developers, CI), otherwise the
 * pinned release from go.dev, downloaded once and verified by SHA-256.
 */
async function ensureGo({ env = process.env, platform = process.platform, arch = process.arch, fetchImpl, log = () => {}, cache = cacheRoot(env, platform) } = {}) {
  const explicit = env.CODEX_SUPERPOWER_GO?.trim();
  if (explicit) {
    const version = goVersionOf(explicit, env);
    if (!version) throw new Error(`CODEX_SUPERPOWER_GO=${explicit} is not a working Go toolchain`);
    return { go: explicit, version, source: "override", cache };
  }
  const { version, archives } = MANIFEST.go;
  const archive = archives[`${platform}-${arch}`];
  if (!archive) throw new Error(`No pinned Go toolchain for ${platform}-${arch}; set CODEX_SUPERPOWER_GO`);
  const toolchains = path.join(cache, "toolchains");
  const home = path.join(toolchains, `go${version}`);
  const go = path.join(home, "bin", platform === "win32" ? "go.exe" : "go");
  if (fs.existsSync(go) && goVersionOf(go, env) === version) return { go, version, source: "pinned", cache };

  log(`cliproxyapi: downloading Go ${version} (${archive.file})`);
  const bytes = verified(
    await fetchBytes(`https://go.dev/dl/${archive.file}`, { fetchImpl, what: `Go ${version}` }),
    archive.sha256,
    archive.file,
  );
  fs.mkdirSync(toolchains, { recursive: true });
  const staging = fs.mkdtempSync(path.join(toolchains, `.go${version}-`));
  try {
    const file = path.join(staging, archive.file);
    fs.writeFileSync(file, bytes);
    const extracted = spawnSync("tar", ["-xf", file, "-C", staging], { encoding: "utf8" });
    if (extracted.status !== 0) throw new Error(`could not unpack ${archive.file}: ${extracted.stderr.trim()}`);
    const unpacked = path.join(staging, "go");
    if (goVersionOf(path.join(unpacked, "bin", path.basename(go)), env) !== version) {
      throw new Error(`the unpacked Go toolchain is not Go ${version}`);
    }
    fs.rmSync(home, { recursive: true, force: true });
    fs.renameSync(unpacked, home);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return { go, version, source: "pinned", cache };
}

/** Environment for every go command: the local toolchain only, the pinned modules, private caches. */
function goEnv(cache, env = process.env) {
  return {
    ...env,
    GOTOOLCHAIN: "local",
    GOFLAGS: "-mod=readonly",
    GOPATH: path.join(cache, "gopath"),
    GOMODCACHE: path.join(cache, "gomod"),
    GOCACHE: path.join(cache, "gobuild"),
  };
}

/** Read ClientID and ClientSecret from upstream's constants.go. */
function parseAntigravityClient(source) {
  const id = /\bClientID\s*=\s*"([^"]+)"/.exec(source)?.[1];
  const secret = /\bClientSecret\s*=\s*"([^"]+)"/.exec(source)?.[1];
  if (!id || !secret) throw new Error("the pinned upstream Antigravity source does not declare ClientID and ClientSecret");
  return { clientId: id, clientSecret: secret };
}

/**
 * The public Antigravity OAuth client, from upstream CLIProxyAPI at the pinned commit. Cached after
 * the first fetch; never printed.
 */
async function antigravityClient({ env = process.env, fetchImpl, cache = cacheRoot(env) } = {}) {
  const pin = MANIFEST.antigravityClient;
  const cached = path.join(cache, `antigravity-client-${pin.sha256.slice(0, 16)}.json`);
  try {
    const value = JSON.parse(fs.readFileSync(cached, "utf8"));
    if (value?.clientId && value?.clientSecret) return value;
  } catch {}
  const url = `https://raw.githubusercontent.com/${pin.repository}/${pin.commit}/${pin.path}`;
  const source = verified(await fetchBytes(url, { fetchImpl, what: "the upstream Antigravity client" }), pin.sha256, pin.path).toString("utf8");
  const client = parseAntigravityClient(source);
  fs.mkdirSync(cache, { recursive: true });
  const partial = `${cached}.${process.pid}.partial`;
  fs.writeFileSync(partial, `${JSON.stringify(client)}\n`, { mode: 0o600 });
  fs.renameSync(partial, cached);
  return client;
}

function antigravityLdflags(client) {
  for (const value of [client.clientId, client.clientSecret]) {
    if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error("the Antigravity client has unexpected characters");
  }
  return `-X ${ANTIGRAVITY_PACKAGE}.ClientID=${client.clientId} -X ${ANTIGRAVITY_PACKAGE}.ClientSecret=${client.clientSecret}`;
}

/** Files under `root` that embed an OAuth client secret or client ID literal. */
function embeddedClientLiterals(root) {
  const found = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && fs.statSync(full).size < 4 * 1024 * 1024
        && EMBEDDED_CLIENT_PATTERN.test(fs.readFileSync(full, "utf8"))) found.push(path.relative(root, full));
    }
  };
  walk(root);
  return found;
}

module.exports = {
  ANTIGRAVITY_PACKAGE,
  MANIFEST,
  antigravityClient,
  antigravityLdflags,
  cacheRoot,
  embeddedClientLiterals,
  ensureGo,
  goEnv,
  parseAntigravityClient,
  transientError,
};
