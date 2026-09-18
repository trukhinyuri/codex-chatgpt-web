// Builds CLIProxyAPI from ../cliproxyapi into build/cliproxyapi so the app carries the proxy it
// manages: the proxy then updates and rolls back together with the app, as one artifact.
//
// The Go toolchain and the Antigravity OAuth client come from their official sources, pinned by
// SHA-256 (scripts/cliproxyapi-build.cjs), so a Mac without Go builds the same binary as CI. A
// network failure exits with "[transient]" in the message, which the updater retries later.
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { antigravityClient, antigravityLdflags, ensureGo, goEnv } = require("../../scripts/cliproxyapi-build.cjs");

const launcherRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(launcherRoot, "..");
const component = path.join(repositoryRoot, "cliproxyapi");
const output = path.join(launcherRoot, "build", "cliproxyapi");
const binaryName = process.platform === "win32" ? "cli-proxy-api.exe" : "cli-proxy-api";

function sourceCommit() {
  const head = spawnSync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
  return head.status === 0 && /^[0-9a-f]{40}$/.test(head.stdout.trim()) ? head.stdout.trim() : null;
}

function writeManifest(manifest) {
  fs.writeFileSync(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function main() {
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });

  const toolchain = await ensureGo({ log: console.log });
  const client = await antigravityClient({ cache: toolchain.cache });
  const commit = sourceCommit();
  const shortCommit = commit ? commit.slice(0, 7) : "unknown";
  const builtAt = new Date().toISOString();
  const binary = path.join(output, binaryName);
  const result = spawnSync(toolchain.go, [
    "build",
    "-trimpath",
    "-ldflags",
    `-s -w -X main.Version=superpower-${shortCommit} -X main.Commit=${shortCommit} -X main.BuildDate=${builtAt} ${antigravityLdflags(client)}`,
    "-o",
    binary,
    "./cmd/server",
  ], {
    cwd: component,
    env: goEnv(toolchain.cache),
    encoding: "utf8",
    stdio: ["ignore", "inherit", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    // Module downloads go through proxy.golang.org; a failure there is the network, not the code.
    const network = /dial tcp|i\/o timeout|TLS handshake timeout|no such host|connection (?:refused|reset)|proxy\.golang\.org.*(?:502|503|504)/i.test(result.stderr || "");
    throw new Error(`${network ? "[transient] " : ""}go build of CLIProxyAPI failed with code ${result.status}`);
  }

  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(binary)).digest("hex");
  fs.copyFileSync(path.join(component, "LICENSE"), path.join(output, "LICENSE"));
  writeManifest({
    version: 1,
    bundled: true,
    binary: binaryName,
    sha256,
    sourceCommit: commit,
    proxyVersion: `superpower-${shortCommit}`,
    goVersion: toolchain.version,
    builtAt,
  });
  console.log(`cliproxyapi: bundled ${binaryName} (${sha256.slice(0, 12)}, Go ${toolchain.version})`);
}

main().catch((error) => {
  console.error(`cliproxyapi: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
