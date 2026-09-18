const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const launcherRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(launcherRoot, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(launcherRoot, "package.json"), "utf8"));
const repositoryManifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));

test("the public launcher command uses the Electron bootstrap", () => {
  assert.equal(repositoryManifest.scripts.launcher, "bun run scripts/start-launcher.ts");
  assert.equal(repositoryManifest.scripts.launcher, repositoryManifest.scripts.app);
});

// nativeImage only decodes PNG/JPEG data (Electron's documented image support), never SVG, so a
// macOS tray icon built from an `image/svg+xml` data URL silently produces an empty image and a
// blank menu-bar icon. main.cjs must load a real PNG asset instead, and electron-builder's `files`
// allowlist (it does not glob the whole assets/ directory) must actually ship it.
test("the macOS tray icon is a packaged PNG asset, not an SVG data URL nativeImage cannot decode", () => {
  const main = fs.readFileSync(path.join(launcherRoot, "electron", "main.cjs"), "utf8");
  assert.doesNotMatch(main, /image\/svg\+xml/);
  assert.match(main, /trayTemplate\.png/);
  assert.match(main, /nativeImage\.createFromPath\(TRAY_ICON_PATH\)/);
  assert.ok(manifest.build.files.includes("assets/trayTemplate.png"));
  assert.ok(manifest.build.files.includes("assets/trayTemplate@2x.png"));
  for (const [name, expectedSize] of [["trayTemplate.png", 18], ["trayTemplate@2x.png", 36]]) {
    const assetPath = path.join(launcherRoot, "assets", name);
    assert.ok(fs.existsSync(assetPath), `${name} must exist`);
    const buffer = fs.readFileSync(assetPath);
    assert.deepEqual([...buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${name} must be a real PNG`);
    assert.equal(buffer.readUInt32BE(16), expectedSize, `${name} width`);
    assert.equal(buffer.readUInt32BE(20), expectedSize, `${name} height`);
    // Color type 6 is RGBA -- an opaque fallback (e.g. a flattened screenshot) would not carry the
    // transparency a macOS template tray icon depends on.
    assert.equal(buffer[25], 6, `${name} must carry an alpha channel`);
  }
});

// setLoginItemSettings({ args }) is Windows-only, so "--hidden" never reaches process.argv on a
// real macOS login launch; main.cjs's startHidden computation must fall back to
// openedAtLoginOnMac (see tests/autostart.test.cjs for that helper's own behavior), or a macOS
// user who enabled "start hidden at login" gets a visible window at every login instead.
test("macOS hidden-at-login start does not depend solely on the --hidden argv flag", () => {
  const main = fs.readFileSync(path.join(launcherRoot, "electron", "main.cjs"), "utf8");
  assert.match(main, /openedAtLoginOnMac/);
  const startHiddenLine = main.match(/const startHidden = \(([\s\S]*?)\)\s*\n\s*&&/);
  assert.ok(startHiddenLine, "startHidden must be computed from more than one condition");
  assert.match(startHiddenLine[1], /process\.argv\.includes\("--hidden"\)/);
  assert.match(startHiddenLine[1], /openedAtLoginOnMac\(app\)/);
});

// A healthy external codex-chatgpt-web daemon of this same release (runtime-supervisor.cjs's
// `healthy: true`, see tests/runtime-supervisor.test.cjs) must not have its Codex route torn down
// as though the runtime had failed to start; see tests/runtime-supervisor.test.cjs for the
// startConfigured() side of this contract.
test("a healthy external runtime owner skips the Codex-route fail-safe teardown", () => {
  const main = fs.readFileSync(path.join(launcherRoot, "electron", "main.cjs"), "utf8");
  const guardIndex = main.indexOf('runtime.status === "external" && runtime.healthy === true');
  const teardownIndex = main.indexOf("restoreCodexRouteAfterRuntimeFailure({ logger, stateStore });", guardIndex);
  assert.ok(guardIndex >= 0, "main.cjs must check runtime.healthy before the fail-safe teardown");
  assert.ok(teardownIndex > guardIndex, "the healthy-external guard must precede the route teardown call");
});

test("the full verification gate audits launcher dependencies", () => {
  const verify = fs.readFileSync(path.join(repositoryRoot, "scripts", "verify.ts"), "utf8");
  assert.equal(manifest.scripts.audit, "bun audit");
  assert.equal(repositoryManifest.scripts["launcher:audit"], "bun run --cwd launcher audit");
  assert.match(verify, /await run\(\["run", "launcher:audit"\]\);/);
});

test("launcher publishes native packages for all supported desktop operating systems", () => {
  assert.equal(manifest.build.appId, "dev.codexwebgpt.launcher");
  assert.equal(manifest.build.artifactName, "codex-web-gpt-${version}-${os}-${arch}.${ext}");
  assert.deepEqual(manifest.build.mac.target, ["dmg", "zip"]);
  assert.deepEqual(
    manifest.build.mac.signIgnore,
    ["[/\\\\]Contents[/\\\\]Resources[/\\\\]runtime[/\\\\]runtime[/\\\\]bun$"],
  );
  assert.deepEqual(manifest.build.win.target, ["nsis"]);
  assert.equal(manifest.build.win.icon, "assets/icon.ico");
  assert.deepEqual(manifest.build.linux.target, ["AppImage"]);
  assert.ok(manifest.build.files.includes("assets/icon.png"));
  assert.ok(manifest.build.files.includes("assets/linux-appimage-runner.sh"));
  assert.ok(manifest.build.asarUnpack.includes("assets/linux-appimage-runner.sh"));
  assert.equal(manifest.build.afterPack, undefined);
  assert.ok(fs.existsSync(path.join(launcherRoot, "assets", "icon.ico")));
  assert.equal(manifest.build.nsis.oneClick, false);
  assert.equal(manifest.build.nsis.perMachine, false);
  assert.equal(manifest.build.nsis.allowElevation, false);
  assert.equal(manifest.build.nsis.runAfterFinish, true);
  assert.match(manifest.build.nsis.guid, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
});

test("release installers resolve checksummed native launcher assets", () => {
  const shellInstaller = fs.readFileSync(path.join(repositoryRoot, "scripts", "install-launcher.sh"), "utf8");
  const windowsInstaller = fs.readFileSync(path.join(repositoryRoot, "scripts", "install-launcher.ps1"), "utf8");
  const devProfile = fs.readFileSync(path.join(repositoryRoot, "src", "dev-chat", "profile.ts"), "utf8");
  const packager = fs.readFileSync(path.join(launcherRoot, "scripts", "package.cjs"), "utf8");
  for (const installer of [shellInstaller, windowsInstaller]) {
    assert.match(installer, /checksums\.txt/);
    assert.match(installer, /SHA-?256/i);
    assert.match(installer, /releases\/download/);
  }
  assert.match(shellInstaller, /PLATFORM="mac"/);
  assert.match(shellInstaller, /PLATFORM="linux"/);
  assert.match(shellInstaller, /codex-web-gpt\.desktop/);
  assert.match(shellInstaller, /--appimage-extract/);
  const publisher = fs.readFileSync(path.join(launcherRoot, "scripts", "publish-artifacts.cjs"), "utf8");
  assert.match(publisher, /-linux-x86_64\(\?=\\\.\).*?-linux-x64/);
  assert.match(packager, /const executable = "node"/);
  assert.doesNotMatch(packager, /process\.execPath/);
  assert.match(packager, /electron-builder\/out\/cli\/cli\.js/);
  assert.match(packager, /target === "--mac" && !env\.CSC_LINK && !env\.CSC_NAME/);
  assert.match(packager, /--config\.mac\.identity=-/);
  assert.match(packager, /verifySignedMacArchive\(\)/);
  assert.match(packager, /codesign[\s\S]*--verify[\s\S]*--deep[\s\S]*--strict/);
  assert.match(packager, /validateRuntimeBundle/);
  assert.doesNotMatch(packager, /electron-builder\.cmd/);
  assert.match(shellInstaller, /shell_quote\(\)/);
  assert.match(shellInstaller, /RUNNER_SOURCE/);
  assert.match(shellInstaller, /exec %s %s "\$@"/);
  assert.doesNotMatch(shellInstaller, /APPIMAGE_EXTRACT_AND_RUN=.*1/);
  assert.ok(
    shellInstaller.indexOf('chmod 0755 "$TEMP_DIR/$ASSET"')
      < shellInstaller.indexOf('"$TEMP_DIR/$ASSET" --appimage-extract'),
    "the downloaded AppImage must be executable before it is inspected",
  );
  assert.match(windowsInstaller, /codex-web-gpt-\$Version-win-\$Arch\.exe/);
  assert.match(windowsInstaller, /\[Environment\]::Is64BitOperatingSystem/);
  assert.doesNotMatch(windowsInstaller, /RuntimeInformation/);
  assert.match(windowsInstaller, /function Test-IsFullyQualifiedWindowsPath/);
  assert.match(windowsInstaller, /Test-IsFullyQualifiedWindowsPath \$InstallLocation/);
  assert.doesNotMatch(windowsInstaller, /IsPathFullyQualified/);
  const windowsPathPattern = windowsInstaller.match(/return \$Path -match '([^']+)'/)?.[1];
  assert.ok(windowsPathPattern, "the Windows installer must expose its absolute-path contract");
  const fullyQualifiedWindowsPath = new RegExp(windowsPathPattern);
  assert.equal(fullyQualifiedWindowsPath.test("C:\\Users\\tester\\Codex Web GPT"), true);
  assert.equal(fullyQualifiedWindowsPath.test("\\\\server\\share\\Codex Web GPT"), true);
  assert.equal(fullyQualifiedWindowsPath.test("C:Codex Web GPT"), false);
  assert.equal(fullyQualifiedWindowsPath.test("\\Codex Web GPT"), false);
  assert.equal(fullyQualifiedWindowsPath.test("Codex Web GPT"), false);
  assert.ok(windowsInstaller.includes(`HKCU:\\Software\\${manifest.build.nsis.guid}`));
  assert.ok(devProfile.includes(`WINDOWS_LAUNCHER_GUID = "${manifest.build.nsis.guid}"`));
  assert.match(windowsInstaller, /Get-ItemPropertyValue[\s\S]*InstallLocation/);
  assert.ok(windowsInstaller.includes(`Join-Path $InstallLocation "${manifest.build.executableName}.exe"`));
  assert.match(windowsInstaller, /-ArgumentList "\/S", "\/currentuser"/);
  const packageSmoke = fs.readFileSync(path.join(launcherRoot, "scripts", "smoke-package.cjs"), "utf8");
  assert.match(packageSmoke, /run\(installer, \["\/S", "\/currentuser"\]/);
  assert.match(packageSmoke, /reg\.exe[\s\S]*InstallLocation/);
});

// Renaming the product to Codex Superpower changes only what people read. Launchers already installed
// (their updater is vendored in tests/fixtures/updater-86f2d311 and exercised by
// legacy-updater-contract.test.cjs) find, check and replace the app by these identities.
test("the renamed product keeps every packaging identity installed launchers depend on", () => {
  const { PRODUCT_COPYRIGHT } = require("../electron/about.cjs");
  assert.equal(manifest.build.productName, "Codex Superpower");
  assert.equal(manifest.build.executableName, "Codex Web GPT", "bundle file name, CFBundleExecutable and the Windows exe");
  assert.equal(manifest.build.mac.executableName, undefined, "the top-level executableName must apply to macOS");
  assert.equal(manifest.build.linux.executableName, "codex-web-gpt-launcher", "Linux keeps its previous default executable");
  assert.equal(manifest.build.appId, "dev.codexwebgpt.launcher");
  assert.equal(manifest.name, "codex-web-gpt-launcher");
  for (const arch of ["arm64", "x64"]) {
    const archive = manifest.build.artifactName
      .replace("${version}", manifest.version)
      .replace("${os}", "mac")
      .replace("${arch}", arch)
      .replace("${ext}", "zip");
    assert.match(archive, new RegExp(`^codex-web-gpt-.+-mac-${arch}\\.zip$`), "the 86f2d311 findPackage pattern");
  }
  assert.equal(manifest.build.copyright, PRODUCT_COPYRIGHT, "the About panel and Info.plist show the same copyright");
  assert.match(manifest.build.copyright, /Yuri Trukhin[\s\S]*Codex Web GPT by miuuyy and contributors[\s\S]*MIT License/);
  const author = { name: "Yuri Trukhin", email: "yuri@trukhin.com", url: "https://github.com/trukhinyuri" };
  assert.deepEqual(manifest.author, author);
  assert.deepEqual(repositoryManifest.author, author);

  const packager = fs.readFileSync(path.join(launcherRoot, "scripts", "package.cjs"), "utf8");
  assert.doesNotMatch(packager, /productName\}\.app/, "the bundle is found, never derived from productName");
  assert.match(packager, /findSingleApplication\(verificationRoot\)/);
  assert.match(packager, /--config\.mac\.extendInfo\.CodexWebGptSourceCommit=/);
  assert.match(packager, /--config\.mac\.extendInfo\.CodexWebGptSourceState=/);
  assert.match(packager, /--config\.extraMetadata\.sourceCommit=/);
  // Published only after the signature check, and through the step tested below.
  assert.match(packager, /verifySignedMacArchive\(\);[\s\S]*publishArtifacts\(\{ staging, artifactsDirectory, target, arch: process\.arch, sourceCommit \}\);\s*\} finally \{/);
  const smoke = fs.readFileSync(path.join(launcherRoot, "scripts", "smoke-package.cjs"), "utf8");
  assert.doesNotMatch(smoke, /"Codex Web GPT\.app"|productName\}\.exe/);
  assert.match(smoke, /findSingleApplication\(stage\)/);
  const license = fs.readFileSync(path.join(repositoryRoot, "LICENSE"), "utf8");
  assert.match(license, /^Copyright \(c\) 2026 codex-chatgpt-web contributors\r?\nCopyright \(c\) 2026 Yuri Trukhin\r?$/m);
});

// The fork's installer and rollback script quit the running launcher through AppleScript. By name,
// "Codex Web GPT" could resolve to an older copy LaunchServices still knows under that CFBundleName
// (a backup, a download) and open it; by bundle id it reaches the launcher that runs.
test("the fork's install and rollback scripts quit the launcher by bundle id, never by name", () => {
  const quit = `osascript -e 'tell application id "${manifest.build.appId}" to quit'`;
  for (const [script, sites] of [["install-fork-macos.sh", 2], ["rollback-fork-macos.sh", 1]]) {
    const source = fs.readFileSync(path.join(repositoryRoot, "scripts", script), "utf8");
    assert.equal(source.split(quit).length - 1, sites, `${script} quits by bundle id at every quit site`);
    assert.doesNotMatch(source, /tell application "/, `${script} never addresses the app by name`);
  }
});

// The update worker now runs from the app's own executable, so its command line starts with the same
// path as a running launcher. A script that mistook it for one would refuse to install, or kill the
// worker in the middle of replacing the app.
test("the fork's scripts do not mistake the update worker for a running launcher", () => {
  for (const script of ["install-fork-macos.sh", "rollback-fork-macos.sh"]) {
    const file = path.join(repositoryRoot, "scripts", script);
    const source = fs.readFileSync(file, "utf8");
    assert.match(source, /launcher_pids\(\) \{\n  pgrep -af "\$APP_PROC" 2>\/dev\/null \| grep -v source-update-worker\.cjs/, script);
    assert.doesNotMatch(source, /pkill[^\n]*APP_PROC/, `${script} never signals every process under the app's executable`);
    const parsed = spawnSync("/bin/bash", ["-n", file], { encoding: "utf8" });
    assert.equal(parsed.status, 0, `${script} parses: ${parsed.stderr}`);
  }
});

const { publishArtifacts } = require("../scripts/publish-artifacts.cjs");
const PUBLISH_COMMIT = "c".repeat(40);
const PUBLISH_ARCH = process.arch === "x64" ? "x64" : "arm64";
const macOnly = { skip: process.platform !== "darwin" && "the check uses macOS ditto and plutil" };

function publishWorkspace(t) {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cwg-publish-")), "w.noindex");
  t.after(() => fs.rmSync(path.dirname(root), { recursive: true, force: true }));
  const staging = path.join(root, "staging");
  const artifactsDirectory = path.join(root, "artifacts");
  fs.mkdirSync(staging, { recursive: true });
  fs.mkdirSync(artifactsDirectory, { recursive: true });
  // What an earlier build left behind: its package goes, anything else stays.
  fs.writeFileSync(path.join(artifactsDirectory, `codex-web-gpt-5.0.7-mac-${PUBLISH_ARCH}.zip`), "previous build");
  fs.writeFileSync(path.join(artifactsDirectory, "notes.txt"), "not a package");
  return { root, staging, artifactsDirectory };
}

const packagesIn = directory => fs.readdirSync(directory)
  .filter(name => /\.(?:AppImage|dmg|exe|zip|blockmap)$/i.test(name))
  .sort();

/** A staged macOS zip laid out like electron-builder's, with app.asar as a folder the check also reads. */
function stageMacZip(staging, { executableName = "Codex Web GPT", commit = PUBLISH_COMMIT } = {}) {
  const build = fs.mkdtempSync(path.join(path.dirname(staging), "bundle-"));
  const bundle = path.join(build, `${executableName}.app`);
  fs.mkdirSync(path.join(bundle, "Contents", "MacOS"), { recursive: true });
  fs.mkdirSync(path.join(bundle, "Contents", "Resources", "app.asar"), { recursive: true });
  fs.writeFileSync(path.join(bundle, "Contents", "MacOS", executableName), "#!/bin/sh\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bundle, "Contents", "Info.plist"), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    `<plist version="1.0"><dict><key>CFBundleName</key><string>Codex Superpower</string><key>CFBundleExecutable</key><string>${executableName}</string><key>CodexWebGptSourceCommit</key><string>${commit}</string></dict></plist>`,
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(bundle, "Contents", "Resources", "app.asar", "package.json"), JSON.stringify({ sourceCommit: commit }));
  const zip = path.join(staging, `codex-web-gpt-5.0.8-mac-${PUBLISH_ARCH}.zip`);
  const zipped = spawnSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", bundle, zip], { encoding: "utf8" });
  assert.equal(zipped.status, 0, zipped.stderr);
  fs.writeFileSync(`${zip}.blockmap`, "blockmap");
  fs.writeFileSync(path.join(staging, `codex-web-gpt-5.0.8-mac-${PUBLISH_ARCH}.dmg`), "dmg");
}

const macPackages = [
  `codex-web-gpt-5.0.8-mac-${PUBLISH_ARCH}.dmg`,
  `codex-web-gpt-5.0.8-mac-${PUBLISH_ARCH}.zip`,
  `codex-web-gpt-5.0.8-mac-${PUBLISH_ARCH}.zip.blockmap`,
];

test("publishing replaces the previous packages and gives Linux packages their public names", (t) => {
  const { staging, artifactsDirectory } = publishWorkspace(t);
  fs.writeFileSync(path.join(staging, "codex-web-gpt-5.0.8-linux-x86_64.AppImage"), "appimage");
  fs.writeFileSync(path.join(staging, "builder-debug.yml"), "not a package");
  let checked = 0;
  const published = publishArtifacts({
    staging,
    artifactsDirectory,
    target: "--linux",
    sourceCommit: PUBLISH_COMMIT,
    checkMacPackage: () => { checked += 1; },
  });
  assert.deepEqual(published, ["codex-web-gpt-5.0.8-linux-x64.AppImage"]);
  assert.deepEqual(packagesIn(artifactsDirectory), ["codex-web-gpt-5.0.8-linux-x64.AppImage"]);
  assert.ok(fs.existsSync(path.join(artifactsDirectory, "notes.txt")));
  assert.equal(checked, 0, "only macOS packages go through the updater check");
});

test("a staging folder without a package fails and publishes nothing", (t) => {
  const { staging, artifactsDirectory } = publishWorkspace(t);
  fs.writeFileSync(path.join(staging, "only.blockmap"), "blockmap");
  assert.throws(
    () => publishArtifacts({ staging, artifactsDirectory, target: "--linux", sourceCommit: PUBLISH_COMMIT }),
    /produced no distributable artifact/,
  );
  assert.deepEqual(packagesIn(artifactsDirectory), []);
});

test("a macOS package the check refuses is removed with everything published beside it", (t) => {
  const { root, staging, artifactsDirectory } = publishWorkspace(t);
  for (const name of macPackages) fs.writeFileSync(path.join(staging, name), name);
  const calls = [];
  assert.throws(() => publishArtifacts({
    staging,
    artifactsDirectory,
    target: "--mac",
    arch: PUBLISH_ARCH,
    sourceCommit: PUBLISH_COMMIT,
    temporaryParent: root,
    checkMacPackage: (options) => {
      calls.push({ ...options, packages: packagesIn(artifactsDirectory) });
      throw new Error("refused");
    },
  }), /refused/);
  assert.deepEqual(calls, [{
    artifactsDirectory,
    arch: PUBLISH_ARCH,
    expectedCommit: PUBLISH_COMMIT,
    temporaryParent: root,
    packages: macPackages,
  }], "the check sees exactly the new packages");
  assert.deepEqual(packagesIn(artifactsDirectory), [], "no package is left for an installed launcher to pick up");
  assert.ok(fs.existsSync(path.join(artifactsDirectory, "notes.txt")));
});

test("a macOS zip that is not a readable archive fails the real check and leaves no artifacts", macOnly, (t) => {
  const { root, staging, artifactsDirectory } = publishWorkspace(t);
  fs.writeFileSync(path.join(staging, `codex-web-gpt-5.0.8-mac-${PUBLISH_ARCH}.zip`), "this is not a zip archive");
  fs.writeFileSync(path.join(staging, `codex-web-gpt-5.0.8-mac-${PUBLISH_ARCH}.dmg`), "dmg");
  assert.throws(() => publishArtifacts({
    staging,
    artifactsDirectory,
    target: "--mac",
    arch: PUBLISH_ARCH,
    sourceCommit: PUBLISH_COMMIT,
    temporaryParent: root,
    log: () => {},
  }), /Could not extract/);
  assert.deepEqual(packagesIn(artifactsDirectory), []);
  assert.deepEqual(
    fs.readdirSync(root).filter(name => name.startsWith("codex-web-gpt-updater-check-")),
    [],
    "the extraction is removed",
  );
});

test("a macOS zip whose executable was renamed fails the real check and leaves no artifacts", macOnly, (t) => {
  const { root, staging, artifactsDirectory } = publishWorkspace(t);
  stageMacZip(staging, { executableName: "Codex Superpower" });
  assert.throws(() => publishArtifacts({
    staging,
    artifactsDirectory,
    target: "--mac",
    arch: PUBLISH_ARCH,
    sourceCommit: PUBLISH_COMMIT,
    temporaryParent: root,
    log: () => {},
  }), /would not install under launchers already in use[\s\S]*Contents\/MacOS\/Codex Web GPT is missing/);
  assert.deepEqual(packagesIn(artifactsDirectory), []);
});

test("a macOS zip that keeps the installed launchers' identities is published", macOnly, (t) => {
  const { root, staging, artifactsDirectory } = publishWorkspace(t);
  stageMacZip(staging);
  const lines = [];
  const published = publishArtifacts({
    staging,
    artifactsDirectory,
    target: "--mac",
    arch: PUBLISH_ARCH,
    sourceCommit: PUBLISH_COMMIT,
    temporaryParent: root,
    log: line => lines.push(line),
  });
  assert.deepEqual([...published].sort(), macPackages);
  assert.deepEqual(packagesIn(artifactsDirectory), macPackages);
  assert.deepEqual(lines, [
    `Updater compatibility: codex-web-gpt-5.0.8-mac-${PUBLISH_ARCH}.zip -> Codex Web GPT.app `
      + `(CFBundleName Codex Superpower, executable Codex Web GPT, commit ${PUBLISH_COMMIT})`,
  ]);
});

test("packaged launcher owns a detached checksummed updater for every release platform", () => {
  const updater = fs.readFileSync(path.join(launcherRoot, "electron", "update.cjs"), "utf8");
  const worker = fs.readFileSync(path.join(launcherRoot, "electron", "update-worker.cjs"), "utf8");
  for (const platform of ["darwin", "win32", "linux"]) {
    assert.match(updater, new RegExp(`platform === "${platform}"`));
    assert.match(worker, new RegExp(`job\\.platform === "${platform}"`));
  }
  assert.match(updater, /expectedChecksum/);
  assert.match(updater, /SHA-256 verification failed/);
  assert.match(updater, /detached:\s*true/);
  assert.match(worker, /waitForParent/);
  assert.doesNotMatch(worker, /backup/i);
});

test("CI packages and smoke-launches on macOS, Windows, and Linux", () => {
  const ci = fs.readFileSync(path.join(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8");
  const release = fs.readFileSync(path.join(repositoryRoot, ".github", "workflows", "release.yml"), "utf8");
  assert.match(ci, /macos-15, ubuntu-latest, windows-latest/);
  assert.match(ci, /bun run app:package/);
  assert.match(ci, /bun run app:smoke/);
  assert.match(ci, /prepare-linux-libnotify\.sh/);
  assert.match(ci, /prepare-linux-appimage-tools\.cjs/);
  assert.match(ci, /archlinux:base/);
  assert.match(ci, /prepare-windows-baseline-bun\.ps1 -Version 1\.4\.0/);
  for (const runner of ["macos-15", "macos-15-intel", "ubuntu-latest", "windows-latest"]) {
    assert.match(release, new RegExp(runner));
  }
  assert.match(release, /launcher\/build\/runtime/);
  assert.match(release, /bun run app:smoke/);
  assert.match(release, /prepare-linux-libnotify\.sh/);
  assert.match(release, /prepare-linux-appimage-tools\.cjs/);
  assert.match(release, /archlinux:base/);
  assert.match(release, /prepare-windows-baseline-bun\.ps1 -Version 1\.4\.0/);
  assert.match(release, /codesign --verify --deep --strict --verbose=2/);
  assert.match(release, /Codex Web GPT\.app/);
  assert.doesNotMatch(release, /gh release create[\s\S]*?--draft/);
});

test("Linux AppImage fallback uses one owned extraction and removes it on exit", {
  skip: process.platform !== "linux" ? "AppImage process identity is Linux-specific" : false,
}, () => {
  // node:test honours the `skip` option above and reports this as skipped. Bun's shim ignores that
  // option and runs the body anyway, and implements neither t.skip(), so the test read /proc on
  // macOS and failed for everyone running `bun test` locally. Returning early is the one form both
  // runners agree on.
  if (process.platform !== "linux") return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-appimage-runner-"));
  const runtime = path.join(root, "runtime");
  const appImage = path.join(root, "Codex Web GPT.AppImage");
  const appRunSource = path.join(root, "AppRun");
  const marker = path.join(root, "launched");
  const runner = path.join(launcherRoot, "assets", "linux-appimage-runner.sh");
  fs.mkdirSync(runtime);
  fs.writeFileSync(appRunSource, [
    "#!/bin/sh",
    `printf '%s|%s' \"$APPIMAGE\" \"$1\" > ${JSON.stringify(marker)}`,
    "",
  ].join("\n"), { mode: 0o755 });
  fs.writeFileSync(appImage, [
    "#!/bin/sh",
    "if [ \"$1\" != \"--appimage-extract\" ]; then exit 99; fi",
    "mkdir -p squashfs-root",
    "cp \"$FAKE_APPRUN_SOURCE\" squashfs-root/AppRun",
    "chmod 0755 squashfs-root/AppRun",
    "",
  ].join("\n"), { mode: 0o755 });
  const fallbackRoot = path.join(runtime, `codex-web-gpt-appimage-${process.getuid?.() ?? 0}`);
  const stale = path.join(fallbackRoot, "run.stale");
  const active = path.join(fallbackRoot, "run.active");
  const ownerStart = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8")
    .replace(/^[^)]*\) /, "")
    .split(/\s+/)[19];
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(path.join(stale, "owner.pid"), `${process.pid} ${Number(ownerStart) + 1}\n`);
  fs.mkdirSync(active);
  fs.writeFileSync(path.join(active, "owner.pid"), `${process.pid} ${ownerStart}\n`);
  try {
    const result = spawnSync(runner, [appImage, "hello"], {
      encoding: "utf8",
      env: {
        ...process.env,
        APPIMAGE_EXTRACT_AND_RUN: "1",
        FAKE_APPRUN_SOURCE: appRunSource,
        XDG_RUNTIME_DIR: runtime,
      },
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(marker, "utf8"), `${appImage}|hello`);
    assert.deepEqual(fs.readdirSync(fallbackRoot), ["run.active"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Linux packaging replaces libnotify in an owned AppImage toolset before assembly", () => {
  const source = fs.readFileSync(path.join(launcherRoot, "scripts", "prepare-linux-appimage-tools.cjs"), "utf8");
  const prepare = fs.readFileSync(path.join(repositoryRoot, "scripts", "prepare-linux-libnotify.sh"), "utf8");
  const smoke = fs.readFileSync(path.join(launcherRoot, "scripts", "smoke-linux-appimage-symbols.sh"), "utf8");
  const license = fs.readFileSync(
    path.join(repositoryRoot, "LICENSES", "libnotify-0.8.7-LGPL-2.1.md"),
    "utf8",
  );
  for (const contract of [source, prepare, smoke]) {
    assert.match(contract, /notify_notification_get_activation_app_launch_context/);
  }
  assert.match(prepare, /4be15202ec4184fce1ac15997ece5530d2be32fe9573875aeb10e3b573858748/);
  assert.match(source, /getAppImageTools\("0\.0\.0", Arch\.x64\)/);
  assert.match(source, /APPIMAGE_TOOLS_PATH/);
  assert.match(source, /must not replace the shared download cache/);
  assert.match(smoke, /cp "\$APPIMAGE_PATH" "\$SMOKE_APPIMAGE"/);
  assert.doesNotMatch(smoke, /chmod 0755 "\$APPIMAGE_PATH"/);
  assert.match(license, /GNU LESSER GENERAL PUBLIC LICENSE/);
  assert.match(license, /libnotify-0\.8\.7\.tar\.xz/);
});

test("macOS package smoke unregisters its staged app from LaunchServices", () => {
  const smoke = fs.readFileSync(path.join(launcherRoot, "scripts", "smoke-package.cjs"), "utf8");
  assert.match(smoke, /Frameworks\/LaunchServices\.framework\/Support\/lsregister/);
  assert.match(smoke, /\["-u", macAppBundle\]/);
  assert.ok(
    smoke.indexOf('["-u", macAppBundle]') < smoke.indexOf("fs.rmSync(scratch"),
    "the staged app must be unregistered before its bundle is deleted",
  );
});

test("release does not publish demo or screenshot assets", () => {
  const release = fs.readFileSync(path.join(repositoryRoot, ".github", "workflows", "release.yml"), "utf8");
  assert.doesNotMatch(release, /assets\/demo\.gif/);
  assert.doesNotMatch(release, /release-assets\/[^\n]*(?:demo|screenshot)/i);
});

test("Windows packages embed the checksummed Bun baseline runtime for CPUs without AVX2", () => {
  const builder = fs.readFileSync(path.join(repositoryRoot, "scripts", "build-runtime-bundle.ts"), "utf8");
  const baseline = fs.readFileSync(
    path.join(repositoryRoot, "scripts", "prepare-windows-baseline-bun.ps1"),
    "utf8",
  );
  assert.match(builder, /CODEX_CHATGPT_WEB_EMBEDDED_BUN/);
  assert.match(builder, /Embedded Bun must be/);
  assert.match(baseline, /bun-windows-x64-baseline\.zip/);
  assert.match(baseline, /SHASUMS256\.txt/);
  assert.match(baseline, /Get-FileHash[^\n]+SHA256/);
  assert.match(baseline, /CODEX_CHATGPT_WEB_EMBEDDED_BUN=/);
});
