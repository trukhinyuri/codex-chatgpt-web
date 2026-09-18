// Launchers released before the product was renamed to Codex Superpower keep updating themselves with
// the updater they shipped with. tests/fixtures/updater-86f2d311 holds byte-identical copies of that
// updater (installed at 86f2d311); these tests run it, unmodified, against a package laid out the way
// launcher/package.json builds it now, and prove it still installs, starts and keeps the new build.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { resolveLauncherProfile } = require("../electron/profile.cjs");
const { STARTUP_HEALTH_FILE } = require("../electron/source-update.cjs");
const { checkMacUpdaterCompatibility } = require("../scripts/updater-compatibility.cjs");

const launcherRoot = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(launcherRoot, "package.json"), "utf8"));
const LEGACY = path.join(__dirname, "fixtures", "updater-86f2d311");
const DRIVER = path.join(__dirname, "fixtures", "run-legacy-updater.cjs");
const OLD = "1".repeat(40);
const NEW = "2".repeat(40);
const ARCH = process.arch;
const skip = process.platform !== "darwin" ? "the updater uses macOS ditto, plutil and ps"
  : !["arm64", "x64"].includes(ARCH) ? `the updater supports arm64 and x64, not ${ARCH}`
    : false;
const roots = [];
const workers = [];

function processCommand(pid) {
  const listed = spawnSync("/bin/ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  return listed.status === 0 ? listed.stdout.trim() : "";
}

/**
 * Stop an update worker that still runs, so that it never writes into a folder the test deletes. Only
 * a process whose command line names this test's own folder is signalled, never a reused PID.
 */
function stopWorker({ pid, root }) {
  const ours = () => processCommand(pid).includes(root);
  if (!Number.isInteger(pid) || pid <= 0 || !ours()) return;
  try { process.kill(pid, "SIGTERM"); } catch {}
  const deadline = Date.now() + 10_000;
  while (ours() && Date.now() < deadline) spawnSync("/bin/sleep", ["0.1"]);
  if (ours()) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
}

test.after(() => {
  for (const worker of workers) stopWorker(worker);
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

// Git blob ids of launcher/electron/<file> at 86f2d311: the fixtures must stay exact copies.
const LEGACY_BLOBS = {
  "atomic-file.cjs": "dc7dc746a4e654c58af05948ffa77d70640164e0",
  "problem-report.cjs": "0a03fabf38d18dbc226bbcd509af20000d9b7f55",
  "profile.cjs": "b1a20dc7fcfffc0ab45bfe916d173a59d4b93e5a",
  "source-update-worker.cjs": "78ffd695c9042ca9a5742f3582530a1696093d35",
  "source-update.cjs": "1890b41ddcd2ea528bfec2fc5af2e40b250f0d1a",
};

function gitBlobId(file) {
  const content = fs.readFileSync(file);
  return crypto.createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

function plist(entries) {
  const body = Object.entries(entries).map(([key, value]) => `<key>${key}</key><string>${value}</string>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>${body}</dict></plist>
`;
}

/**
 * A stand-in bundle. It has no CFBundleIdentifier, so nothing here can be mistaken for the real app,
 * and app.asar is a folder: plain Node reads it the way Electron's fs reads the real archive.
 */
function makeBundle(bundle, { executableName, productName, commit, script }) {
  fs.mkdirSync(path.join(bundle, "Contents", "MacOS"), { recursive: true });
  fs.mkdirSync(path.join(bundle, "Contents", "Resources", "app.asar"), { recursive: true });
  fs.writeFileSync(path.join(bundle, "Contents", "MacOS", executableName), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bundle, "Contents", "Info.plist"), plist({
    CFBundleName: productName,
    CFBundleDisplayName: productName,
    CFBundleExecutable: executableName,
    CodexWebGptSourceCommit: commit,
    CodexWebGptSourceState: "clean",
  }));
  fs.writeFileSync(path.join(bundle, "Contents", "Resources", "app.asar", "package.json"), JSON.stringify({
    name: manifest.name,
    version: manifest.version,
    sourceCommit: commit,
    sourceState: "clean",
  }));
}

function artifactName(template, { arch = ARCH } = {}) {
  return template
    .replace("${version}", manifest.version)
    .replace("${os}", "mac")
    .replace("${arch}", arch)
    .replace("${ext}", "zip");
}

function readPlist(file, key) {
  const result = spawnSync("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", file], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * This Mac as a launcher released at 86f2d311 sees it: the old app installed under its old name, its
 * profile, and a source checkout whose "package the app" step leaves the package described by `build`.
 */
function scenario({ build = manifest.build, packageName } = {}) {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cwg-legacy-")), "w.noindex");
  roots.push(path.dirname(root));
  const homeDir = path.join(root, "home");
  const appData = path.join(homeDir, "Library", "Application Support");
  const oldProfile = require(path.join(LEGACY, "profile.cjs")).resolveLauncherProfile({ argv: ["electron", "."], env: {}, homeDir, appData });
  const newProfile = resolveLauncherProfile({ argv: ["electron", "."], env: {}, homeDir, appData });
  const marks = path.join(root, "marks.log");
  const installed = path.join(root, "Applications", "Codex Web GPT.app");
  const installedExecutable = path.join(installed, "Contents", "MacOS", "Codex Web GPT");
  // Where the new launcher reports its start: its own profile and its own health file name.
  const newHealth = path.join(newProfile.userData, STARTUP_HEALTH_FILE);
  makeBundle(installed, { executableName: "Codex Web GPT", productName: "Codex Web GPT", commit: OLD, script: `echo old >> "${marks}"` });
  const built = path.join(root, "build", `${build.executableName || build.productName}.app`);
  makeBundle(built, {
    executableName: build.executableName || build.productName,
    productName: build.productName,
    commit: NEW,
    script: [
      `echo new >> "${marks}"`,
      `mkdir -p "${path.dirname(newHealth)}"`,
      `printf '{"version":1,"commit":"${NEW}","pid":%s,"status":"healthy","reason":null,"at":"now"}\\n' $$ > "${newHealth}.tmp" && mv "${newHealth}.tmp" "${newHealth}"`,
    ].join("\n"),
  });
  const name = packageName || artifactName(build.artifactName);
  const packagePath = path.join(root, "build", name);
  const zipped = spawnSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", built, packagePath], { encoding: "utf8" });
  assert.equal(zipped.status, 0, zipped.stderr);
  fs.mkdirSync(oldProfile.userData, { recursive: true });
  const config = {
    version: manifest.version,
    oldCommit: OLD,
    newCommit: NEW,
    arch: ARCH,
    installedExecutable,
    logsDirectory: path.join(oldProfile.userData, "logs"),
    userData: oldProfile.userData,
    sourceRoot: path.join(root, "source"),
    stagingParent: path.join(root, "staging"),
    healthTimeoutMs: 30_000,
    packagePath,
    packageName: name,
    resultPath: path.join(root, "driver-result.json"),
  };
  fs.mkdirSync(config.stagingParent, { recursive: true });
  const configPath = path.join(root, "driver.json");
  fs.writeFileSync(configPath, JSON.stringify(config));
  const read = file => fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const statePath = path.join(oldProfile.userData, "source-update-state.json");
  return {
    root, installed, installedExecutable, oldProfile, newProfile, newHealth, statePath, config,
    run() {
      const driver = spawnSync(process.execPath, [DRIVER, configPath], { encoding: "utf8", timeout: 60_000 });
      const result = JSON.parse(read(config.resultPath) || "null");
      if (result?.workerPid) workers.push({ pid: result.workerPid, root });
      return { status: driver.status, stderr: driver.stderr, result };
    },
    /** The worker runs detached after the old launcher exits; wait until it has settled. */
    waitForWorker(tempRoot) {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const state = JSON.parse(read(statePath) || "null");
        if (state?.lastResult && !fs.existsSync(tempRoot)) return state;
        spawnSync("/bin/sleep", ["0.2"]);
      }
      return JSON.parse(read(statePath) || "null");
    },
    marks: () => read(marks).trim().split("\n").filter(Boolean),
    log: () => read(path.join(config.logsDirectory, "source-update.log")),
    rollbacks: () => {
      const store = path.join(oldProfile.userData, "rollback.noindex");
      return fs.existsSync(store) ? fs.readdirSync(store).sort() : [];
    },
  };
}

test("the vendored 86f2d311 updater is byte-identical to the one installed launchers run", () => {
  for (const [file, blob] of Object.entries(LEGACY_BLOBS)) {
    assert.equal(gitBlobId(path.join(LEGACY, file)), blob, `${file} was edited; restore it with git show 86f2d311:launcher/electron/${file}`);
  }
});

test("launchers before and after the rename share userData, and the health file the old worker reads", () => {
  const homeDir = path.resolve("/Users/tester");
  const appData = path.join(homeDir, "Library", "Application Support");
  const legacy = require(path.join(LEGACY, "profile.cjs")).resolveLauncherProfile({ argv: ["electron", "."], env: {}, homeDir, appData });
  const current = resolveLauncherProfile({ argv: ["electron", "."], env: {}, homeDir, appData });
  assert.equal(legacy.displayName, "Codex Web GPT");
  assert.equal(current.displayName, "Codex Superpower");
  assert.equal(current.userData, legacy.userData);
  assert.equal(current.userData, path.join(appData, "Codex Web GPT"));
  assert.equal(current.browserPartition, legacy.browserPartition);
  assert.equal(current.coreHome, legacy.coreHome);
  assert.equal(STARTUP_HEALTH_FILE, require(path.join(LEGACY, "source-update.cjs")).STARTUP_HEALTH_FILE);
});

test("an 86f2d311 launcher installs the renamed build over itself and keeps it after a healthy start", { skip }, () => {
  const install = scenario();
  const { status, stderr, result } = install.run();
  assert.equal(status, 0, `${stderr}\n${JSON.stringify(result)}\n${install.log()}`);
  assert.equal(result.workerStarted, true, "the worker confirmed before the old launcher quit");
  // The worker now runs detached. Let it finish before any assertion can end the test; test.after
  // stops it if it still runs then.
  const state = install.waitForWorker(result.job.tempRoot);

  assert.equal(result.check.status, "available");
  assert.equal(result.check.automatic, true);
  assert.ok(result.steps.some(step => step.includes("app:package")), "the new scripts package the app");
  // findPackage accepted the artifact name, findMacApplication the bundle, and the job keeps the
  // installed path and the old executable name.
  assert.equal(path.basename(result.job.source), `${manifest.build.executableName}.app`);
  assert.equal(result.job.target, install.installed);
  assert.equal(result.job.executableName, "Codex Web GPT");
  assert.equal(result.job.healthPath, install.newHealth, "the old worker waits on the file the new launcher writes");
  assert.equal(result.job.healthPath, path.join(install.config.userData, "source-update-health.json"));
  assert.equal(path.basename(path.dirname(result.job.healthPath)), "Codex Web GPT");

  assert.equal(state?.lastResult?.result, "installed", install.log());
  assert.equal(state.lastResult.commit, NEW);
  assert.deepEqual(state.failedCommits, {});
  // The new build now sits at the old path, under the old file name, and it is the one that ran.
  assert.deepEqual(fs.readdirSync(path.dirname(install.installed)), ["Codex Web GPT.app"]);
  const plistPath = path.join(install.installed, "Contents", "Info.plist");
  assert.equal(readPlist(plistPath, "CFBundleName"), "Codex Superpower");
  assert.equal(readPlist(plistPath, "CFBundleExecutable"), "Codex Web GPT");
  assert.equal(readPlist(plistPath, "CodexWebGptSourceCommit"), NEW);
  assert.match(fs.readFileSync(install.installedExecutable, "utf8"), /echo new/);
  assert.deepEqual(install.marks(), ["new"], "the old app was not started again: no rollback");
  const health = JSON.parse(fs.readFileSync(install.newHealth, "utf8"));
  assert.equal(health.commit, NEW);
  assert.equal(health.status, "healthy");
  assert.doesNotMatch(install.log(), /rolling back|ROLLBACK FAILED/);
  // The replaced build is only kept for a manual rollback.
  const [entry, ...others] = install.rollbacks();
  assert.deepEqual(others, []);
  assert.match(entry, new RegExp(`^\\d{8}T\\d{6}Z-${OLD.slice(0, 12)}$`));
  const saved = path.join(install.oldProfile.userData, "rollback.noindex", entry, "Codex Web GPT.app");
  assert.match(fs.readFileSync(path.join(saved, "Contents", "MacOS", "Codex Web GPT"), "utf8"), /echo old/);
  // The same package passes the check package.cjs runs after packaging.
  const checked = checkMacUpdaterCompatibility({
    artifactsDirectory: path.join(install.config.sourceRoot, "launcher", "artifacts"),
    arch: ARCH,
    expectedCommit: NEW,
    temporaryParent: install.root,
  });
  assert.equal(checked.application, "Codex Web GPT.app");
  assert.equal(checked.bundleName, "Codex Superpower");
});

test("a build whose executable is renamed never installs under an 86f2d311 launcher and is rebuilt forever", { skip }, () => {
  const install = scenario({ build: { ...manifest.build, executableName: "Codex Superpower" } });
  const { status, result } = install.run();
  assert.equal(status, 4, JSON.stringify(result));
  assert.match(result.launchError, /did not confirm that it can install the staged build/);
  assert.equal(result.workerStarted, false);
  assert.equal(result.stageLeft, false, "the verified stage is deleted, so the next check builds it again");
  const state = JSON.parse(fs.existsSync(install.statePath) ? fs.readFileSync(install.statePath, "utf8") : "null");
  assert.equal(state?.failedCommits?.[NEW], undefined, "nothing marks the commit as failed");
  assert.match(fs.readFileSync(install.installedExecutable, "utf8"), /echo old/);
  assert.deepEqual(install.rollbacks(), []);
  // package.cjs refuses to leave such a package behind.
  assert.throws(() => checkMacUpdaterCompatibility({
    artifactsDirectory: path.join(install.config.sourceRoot, "launcher", "artifacts"),
    arch: ARCH,
    expectedCommit: NEW,
    temporaryParent: install.root,
  }), /Contents\/MacOS\/Codex Web GPT is missing[\s\S]*CFBundleExecutable is Codex Superpower/);
});

test("a package that is not named codex-web-gpt-*-mac-<arch>.zip fails the 86f2d311 build step", { skip }, () => {
  const install = scenario({ packageName: `codex-superpower-${manifest.version}-mac-${ARCH}.zip` });
  const { status, result } = install.run();
  assert.equal(status, 3, JSON.stringify(result));
  assert.match(result.beginInstallError, new RegExp(`Expected one fresh macOS ${ARCH} package`));
  const state = JSON.parse(fs.readFileSync(install.statePath, "utf8"));
  assert.equal(state.failedCommits[NEW].stage, "build");
  assert.match(fs.readFileSync(install.installedExecutable, "utf8"), /echo old/);
  assert.throws(() => checkMacUpdaterCompatibility({
    artifactsDirectory: path.join(install.config.sourceRoot, "launcher", "artifacts"),
    arch: ARCH,
    expectedCommit: NEW,
    temporaryParent: install.root,
  }), /not named codex-web-gpt-\*-mac-<arch>\.zip/);
});
