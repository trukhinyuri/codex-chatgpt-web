const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { validateRuntimeBundle } = require("../electron/runtime-install.cjs");
const { checkMacUpdaterCompatibility, findSingleApplication } = require("./updater-compatibility.cjs");

const root = path.resolve(__dirname, "..");
const launcherManifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const executable = "node";
const electronBuilderCli = require.resolve("electron-builder/out/cli/cli.js", { paths: [root] });
const requested = process.argv[2];
const target = requested || (process.platform === "darwin" ? "--mac"
  : process.platform === "win32" ? "--win"
    : process.platform === "linux" ? "--linux"
      : null);
if (!["--mac", "--win", "--linux"].includes(target)) {
  throw new Error(`Unsupported packaging target: ${requested || process.platform}`);
}
const nativeTarget = process.platform === "darwin" ? "--mac"
  : process.platform === "win32" ? "--win"
    : process.platform === "linux" ? "--linux"
      : null;
if (target !== nativeTarget) {
  throw new Error(
    `Cross-packaging ${target} from ${process.platform}/${process.arch} is disabled because the launcher embeds a native Bun runtime. `
    + "Build each target on its matching operating system.",
  );
}

const env = { ...process.env };
if (!env.CSC_LINK && !env.CSC_NAME) env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
const builderArgs = [
  electronBuilderCli,
  target,
  "--publish",
  "never",
];
if (target === "--mac" && !env.CSC_LINK && !env.CSC_NAME) {
  builderArgs.push("--config.mac.identity=-");
}

// Stamp the package with the commit it was built from. The launcher's source updater compares this
// stamp with the fork's main branch; a build with local changes is always offered the update.
const sourceRoot = path.resolve(root, "..");
const sourceHead = spawnSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
const sourceCommit = sourceHead.status === 0 && /^[0-9a-f]{40}$/.test(sourceHead.stdout.trim()) ? sourceHead.stdout.trim() : null;
if (sourceCommit) {
  const sourceChanges = spawnSync("git", ["-C", sourceRoot, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" });
  const sourceState = sourceChanges.status === 0 && sourceChanges.stdout.trim() === "" ? "clean" : "dirty";
  builderArgs.push(`--config.extraMetadata.sourceCommit=${sourceHead.stdout.trim()}`);
  builderArgs.push(`--config.extraMetadata.sourceState=${sourceState}`);
  // Scripts (install, rollback) read the same stamp from Info.plist without unpacking app.asar.
  if (target === "--mac") {
    builderArgs.push(`--config.mac.extendInfo.CodexWebGptSourceCommit=${sourceHead.stdout.trim()}`);
    builderArgs.push(`--config.mac.extendInfo.CodexWebGptSourceState=${sourceState}`);
  }
}

const staging = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-package-"));
const artifactsDirectory = path.join(root, "artifacts");

function runChecked(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with status ${result.status ?? "unknown"}`);
  }
}

function verifySignedMacArchive() {
  const archives = fs.readdirSync(staging)
    .filter(name => /-mac-(?:arm64|x64)\.zip$/.test(name));
  if (archives.length !== 1) {
    throw new Error(`Expected exactly one macOS ZIP for verification; found ${archives.join(", ") || "none"}`);
  }
  const verificationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-mac-verify-"));
  try {
    runChecked("ditto", ["-x", "-k", path.join(staging, archives[0]), verificationRoot]);
    // The bundle is named after build.executableName, not the product name; take the one that is there.
    const appBundle = findSingleApplication(verificationRoot);
    runChecked("codesign", ["--verify", "--deep", "--strict", appBundle]);
    validateRuntimeBundle(path.join(appBundle, "Contents", "Resources", "runtime"), {
      version: launcherManifest.version,
      platform: "darwin",
      arch: process.arch,
    });
  } finally {
    fs.rmSync(verificationRoot, { recursive: true, force: true });
  }
}

try {
  const result = spawnSync(executable, [
    ...builderArgs,
    `--config.directories.output=${staging}`,
  ], {
    cwd: root,
    env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  if (target === "--mac") verifySignedMacArchive();

  fs.mkdirSync(artifactsDirectory, { recursive: true });
  for (const entry of fs.readdirSync(artifactsDirectory, { withFileTypes: true })) {
    if (entry.isFile() && /\.(?:AppImage|dmg|exe|zip|blockmap)$/i.test(entry.name)) {
      fs.rmSync(path.join(artifactsDirectory, entry.name), { force: true });
    }
  }
  const artifacts = fs.readdirSync(staging, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:AppImage|dmg|exe|zip|blockmap)$/i.test(entry.name));
  if (!artifacts.some((entry) => /\.(?:AppImage|dmg|exe|zip)$/i.test(entry.name))) {
    throw new Error(`electron-builder produced no distributable artifact in ${staging}`);
  }
  const published = [];
  for (const artifact of artifacts) {
    const publicName = artifact.name.replace(/-linux-x86_64(?=\.)/, "-linux-x64");
    fs.copyFileSync(path.join(staging, artifact.name), path.join(artifactsDirectory, publicName));
    published.push(publicName);
  }
  if (target === "--mac") {
    // Launchers already installed update themselves from what this script leaves in artifacts/.
    // A package they could not install is removed, and the build fails once instead.
    try {
      const checked = checkMacUpdaterCompatibility({ artifactsDirectory, arch: process.arch, expectedCommit: sourceCommit });
      process.stdout.write(`Updater compatibility: ${checked.archive} -> ${checked.application} (CFBundleName ${checked.bundleName}, executable ${checked.executable}, commit ${checked.commit})\n`);
    } catch (error) {
      for (const name of published) fs.rmSync(path.join(artifactsDirectory, name), { force: true });
      throw error;
    }
  }
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
