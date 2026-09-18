const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const asar = require("@electron/asar");
const {
  checkMacUpdaterCompatibility,
  findSingleApplication,
  readAsarFile,
} = require("../scripts/updater-compatibility.cjs");

const COMMIT = "a".repeat(40);
const OTHER = "b".repeat(40);
const ARCH = process.arch === "x64" ? "x64" : "arm64";
const macOnly = { skip: process.platform !== "darwin" && "the check uses macOS ditto and plutil" };
const roots = [];
test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function workspace() {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cwg-compat-")), "w.noindex");
  roots.push(path.dirname(root));
  fs.mkdirSync(path.join(root, "artifacts"), { recursive: true });
  return root;
}

function plist(entries) {
  const body = Object.entries(entries)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `<key>${key}</key><string>${value}</string>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>${body}</dict></plist>
`;
}

/** A bundle shaped like electron-builder's output, with a real app.asar; no CFBundleIdentifier. */
async function packageBundle(root, {
  bundleName = "Codex Web GPT.app",
  executableName = "Codex Web GPT",
  plistExecutable = executableName,
  stamp = COMMIT,
  asarCommit = COMMIT,
  zipName = `codex-web-gpt-5.0.8-mac-${ARCH}.zip`,
  extraBundle = null,
} = {}) {
  const build = path.join(root, "build", zipName);
  const bundle = path.join(build, bundleName);
  fs.mkdirSync(path.join(bundle, "Contents", "MacOS"), { recursive: true });
  fs.mkdirSync(path.join(bundle, "Contents", "Resources"), { recursive: true });
  fs.writeFileSync(path.join(bundle, "Contents", "MacOS", executableName), "#!/bin/sh\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bundle, "Contents", "Info.plist"), plist({
    CFBundleName: "Codex Superpower",
    CFBundleExecutable: plistExecutable,
    CodexWebGptSourceCommit: stamp,
  }));
  const appSource = path.join(root, "build", `${zipName}-app`);
  fs.mkdirSync(path.join(appSource, "electron"), { recursive: true });
  fs.writeFileSync(path.join(appSource, "package.json"), JSON.stringify({ name: "codex-web-gpt-launcher", sourceCommit: asarCommit }));
  fs.writeFileSync(path.join(appSource, "electron", "main.cjs"), "module.exports = 1;\n");
  await asar.createPackage(appSource, path.join(bundle, "Contents", "Resources", "app.asar"));
  if (extraBundle) fs.mkdirSync(path.join(build, extraBundle, "Contents"), { recursive: true });
  const zipped = spawnSync("/usr/bin/ditto", ["-c", "-k", build, path.join(root, "artifacts", zipName)], { encoding: "utf8" });
  assert.equal(zipped.status, 0, zipped.stderr);
}

function check(root, expectedCommit = COMMIT) {
  return checkMacUpdaterCompatibility({
    artifactsDirectory: path.join(root, "artifacts"),
    arch: ARCH,
    expectedCommit,
    temporaryParent: root,
  });
}

test("@electron/asar, which these tests pack archives with, is a declared dev dependency at its locked version", () => {
  const launcherRoot = path.resolve(__dirname, "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(launcherRoot, "package.json"), "utf8"));
  const locked = /"@electron\/asar": \["@electron\/asar@([^"]+)"/.exec(fs.readFileSync(path.join(launcherRoot, "bun.lock"), "utf8"))?.[1];
  assert.ok(locked, "bun.lock resolves @electron/asar");
  assert.equal(manifest.devDependencies["@electron/asar"], locked);
  assert.equal(require("@electron/asar/package.json").version, locked);
});

test("readAsarFile reads a packed file exactly as @electron/asar wrote it", async () => {
  const root = workspace();
  const source = path.join(root, "app");
  fs.mkdirSync(path.join(source, "dist"), { recursive: true });
  const manifest = JSON.stringify({ name: "codex-web-gpt-launcher", sourceCommit: COMMIT, text: "Codex Superpower ✓" });
  fs.writeFileSync(path.join(source, "dist", "index.html"), "<html>".repeat(5000));
  fs.writeFileSync(path.join(source, "package.json"), manifest);
  const archive = path.join(root, "app.asar");
  await asar.createPackage(source, archive);
  assert.equal(readAsarFile(archive, "package.json").toString("utf8"), manifest);
  assert.deepEqual(readAsarFile(archive, "package.json"), asar.extractFile(archive, "package.json"));
  assert.throws(() => readAsarFile(archive, "missing.json"), /does not contain a packed missing\.json/);
});

test("findSingleApplication takes the only bundle, whatever it is named", () => {
  const root = workspace();
  fs.mkdirSync(path.join(root, "one", "Codex Superpower.app"), { recursive: true });
  assert.equal(findSingleApplication(path.join(root, "one")), path.join(root, "one", "Codex Superpower.app"));
  fs.mkdirSync(path.join(root, "two", "A.app"), { recursive: true });
  fs.mkdirSync(path.join(root, "two", "B.app"), { recursive: true });
  assert.throws(() => findSingleApplication(path.join(root, "two")), /exactly one application bundle[\s\S]*A\.app, B\.app/);
  fs.mkdirSync(path.join(root, "none"), { recursive: true });
  assert.throws(() => findSingleApplication(path.join(root, "none")), /found none/);
});

test("a package that keeps the legacy bundle, executable, name pattern and stamps passes", macOnly, async () => {
  const root = workspace();
  await packageBundle(root);
  assert.deepEqual(check(root), {
    archive: `codex-web-gpt-5.0.8-mac-${ARCH}.zip`,
    application: "Codex Web GPT.app",
    executable: "Codex Web GPT",
    commit: COMMIT,
    bundleName: "Codex Superpower",
  });
  assert.deepEqual(fs.readdirSync(root).filter(name => name.startsWith("codex-web-gpt-updater-check-")), [], "the extraction is removed");
});

test("a renamed executable fails: installed launchers would rebuild it every hour", macOnly, async () => {
  const root = workspace();
  await packageBundle(root, { executableName: "Codex Superpower" });
  assert.throws(() => check(root), /Contents\/MacOS\/Codex Web GPT is missing or not executable; CFBundleExecutable is Codex Superpower, not Codex Web GPT/);
});

test("a bundle renamed away from Codex Web GPT.app fails while the install scripts expect that name", macOnly, async () => {
  const root = workspace();
  await packageBundle(root, { bundleName: "Codex Superpower.app" });
  assert.throws(() => check(root), /the bundle is Codex Superpower\.app, not Codex Web GPT\.app/);
});

test("more than one bundle in the package fails", macOnly, async () => {
  const root = workspace();
  await packageBundle(root, { extraBundle: "Other.app" });
  assert.throws(() => check(root), /exactly one application bundle/);
});

test("a package name the legacy updater does not look for fails", macOnly, async () => {
  const root = workspace();
  await packageBundle(root, { zipName: `codex-superpower-5.0.8-mac-${ARCH}.zip` });
  assert.throws(() => check(root), /not named codex-web-gpt-\*-mac-<arch>\.zip: codex-superpower-5\.0\.8-mac-/);
});

test("two packages for the same architecture fail", macOnly, async () => {
  const root = workspace();
  await packageBundle(root);
  await packageBundle(root, { zipName: `codex-web-gpt-5.0.9-mac-${ARCH}.zip` });
  assert.throws(() => check(root), /expected exactly one codex-web-gpt-\*-mac-/);
});

test("stamps from another commit, or none, fail", macOnly, async () => {
  const wrongStamp = workspace();
  await packageBundle(wrongStamp, { stamp: OTHER });
  assert.throws(() => check(wrongStamp), new RegExp(`CodexWebGptSourceCommit is ${OTHER}, not ${COMMIT}`));
  const wrongAsar = workspace();
  await packageBundle(wrongAsar, { asarCommit: OTHER });
  assert.throws(() => check(wrongAsar), new RegExp(`app\\.asar/package\\.json sourceCommit is ${OTHER}, not ${COMMIT}`));
  const noStamp = workspace();
  await packageBundle(noStamp, { stamp: null, asarCommit: null });
  assert.throws(() => check(noStamp), /CodexWebGptSourceCommit is missing[\s\S]*sourceCommit is missing/);
});

test("a build without a known source commit fails before anything is read", () => {
  const root = workspace();
  assert.throws(() => check(root, null), /source commit is unknown/);
  assert.throws(() => check(root, "HEAD"), /source commit is unknown/);
});
