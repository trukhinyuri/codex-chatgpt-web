// A macOS package must stay installable by every launcher already in use. The updater of builds
// released before the product was renamed to Codex Superpower (launcher/tests/fixtures/updater-86f2d311)
// builds the new commit with that commit's own scripts and then:
//   - takes the one fresh launcher/artifacts/codex-web-gpt-*-mac-<arch>.zip,
//   - installs the first .app inside it over its own bundle,
//   - before it confirms the job, requires Contents/MacOS/<its own executable name>, "Codex Web GPT",
//   - compares the CodexWebGptSourceCommit stamp and app.asar's sourceCommit with the built commit.
// A package that misses the executable is never recorded as failed: that updater deletes the stage and
// builds the same commit again every hour. The installer and rollback scripts also expect the bundle to
// be named "Codex Web GPT.app". So packaging fails instead.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const LEGACY_EXECUTABLE_NAME = "Codex Web GPT";
const LEGACY_BUNDLE_NAME = `${LEGACY_EXECUTABLE_NAME}.app`;
const LEGACY_ARCHIVE_PATTERN = /^codex-web-gpt-.+-mac-(arm64|x64)\.zip$/;
const MAC_ARCHIVE_PATTERN = /-mac-(?:arm64|x64)\.zip$/;
const SOURCE_COMMIT_KEY = "CodexWebGptSourceCommit";
const COMMIT = /^[0-9a-f]{40}$/;

/** The one application bundle at the top of an extracted package; its file name is not assumed. */
function findSingleApplication(root) {
  const bundles = fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.endsWith(".app"))
    .map(entry => entry.name)
    .sort();
  if (bundles.length !== 1) {
    throw new Error(`Expected exactly one application bundle in ${root}; found ${bundles.join(", ") || "none"}`);
  }
  return path.join(root, bundles[0]);
}

/** Read one file from an app.asar archive (Chromium pickle header, then the packed files). */
function readAsarFile(archive, name) {
  const fd = fs.openSync(archive, "r");
  try {
    const sizeBuffer = Buffer.alloc(8);
    if (fs.readSync(fd, sizeBuffer, 0, 8, 0) !== 8) throw new Error(`${archive} has no asar header`);
    const headerSize = sizeBuffer.readUInt32LE(4);
    const headerBuffer = Buffer.alloc(headerSize);
    if (fs.readSync(fd, headerBuffer, 0, headerSize, 8) !== headerSize) throw new Error(`${archive} has a truncated asar header`);
    const stringLength = headerBuffer.readInt32LE(4);
    const header = JSON.parse(headerBuffer.subarray(8, 8 + stringLength).toString("utf8"));
    const entry = header?.files?.[name];
    if (!entry || typeof entry.size !== "number" || entry.unpacked || entry.files) {
      throw new Error(`${archive} does not contain a packed ${name}`);
    }
    const content = Buffer.alloc(entry.size);
    const offset = 8 + headerSize + Number.parseInt(entry.offset, 10);
    if (fs.readSync(fd, content, 0, entry.size, offset) !== entry.size) throw new Error(`${archive} ends inside ${name}`);
    return content;
  } finally {
    fs.closeSync(fd);
  }
}

function readPlistValue(plist, key) {
  const result = spawnSync("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist], { encoding: "utf8", timeout: 30_000 });
  if (result.error) throw result.error;
  return result.status === 0 ? result.stdout.trim() : null;
}

function extractZip(archive, destination) {
  const result = spawnSync("/usr/bin/ditto", ["-x", "-k", archive, destination], { encoding: "utf8", timeout: 600_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Could not extract ${archive}: ${result.stderr.trim()}`);
}

/**
 * Throws with every reason the macOS package in `artifactsDirectory` would not install under the
 * updater of launchers released before the rename; returns what it checked otherwise.
 */
function checkMacUpdaterCompatibility({
  artifactsDirectory,
  arch = process.arch,
  expectedCommit,
  temporaryParent = os.tmpdir(),
}) {
  if (!COMMIT.test(String(expectedCommit || ""))) {
    throw new Error("The source commit is unknown, so installed launchers could not verify this package; build from a Git checkout");
  }
  const archives = fs.readdirSync(artifactsDirectory, { withFileTypes: true })
    .filter(entry => entry.isFile() && MAC_ARCHIVE_PATTERN.test(entry.name))
    .map(entry => entry.name)
    .sort();
  const problems = [];
  const foreign = archives.filter(name => !LEGACY_ARCHIVE_PATTERN.test(name));
  if (foreign.length > 0) problems.push(`macOS archives not named codex-web-gpt-*-mac-<arch>.zip: ${foreign.join(", ")}`);
  const ours = archives.filter(name => new RegExp(`^codex-web-gpt-.+-mac-${arch}\\.zip$`).test(name));
  if (ours.length !== 1) {
    problems.push(`expected exactly one codex-web-gpt-*-mac-${arch}.zip in ${artifactsDirectory}; found ${ours.join(", ") || "none"}`);
  }
  if (problems.length > 0) throw new Error(`The macOS package would not install under launchers already in use: ${problems.join("; ")}`);

  const archive = path.join(artifactsDirectory, ours[0]);
  const root = fs.mkdtempSync(path.join(temporaryParent, "codex-web-gpt-updater-check-"));
  try {
    extractZip(archive, root);
    let application;
    try {
      application = findSingleApplication(root);
    } catch (error) {
      throw new Error(`The macOS package would not install under launchers already in use: ${error.message}`);
    }
    const executable = path.join(application, "Contents", "MacOS", LEGACY_EXECUTABLE_NAME);
    const plist = path.join(application, "Contents", "Info.plist");
    if (path.basename(application) !== LEGACY_BUNDLE_NAME) {
      problems.push(`the bundle is ${path.basename(application)}, not ${LEGACY_BUNDLE_NAME} (scripts/install-fork-macos.sh and rollback-fork-macos.sh expect it)`);
    }
    let executableStat = null;
    try { executableStat = fs.statSync(executable); } catch {}
    if (!executableStat?.isFile() || (executableStat.mode & 0o111) === 0) {
      problems.push(`Contents/MacOS/${LEGACY_EXECUTABLE_NAME} is missing or not executable`);
    }
    const bundleExecutable = readPlistValue(plist, "CFBundleExecutable");
    if (bundleExecutable !== LEGACY_EXECUTABLE_NAME) {
      problems.push(`CFBundleExecutable is ${bundleExecutable || "missing"}, not ${LEGACY_EXECUTABLE_NAME}`);
    }
    const stamp = readPlistValue(plist, SOURCE_COMMIT_KEY);
    if (stamp !== expectedCommit) problems.push(`${SOURCE_COMMIT_KEY} is ${stamp || "missing"}, not ${expectedCommit}`);
    try {
      // The updater reads this path with Electron's fs, which opens an asar archive and a plain folder
      // alike; accept both here too.
      const asar = path.join(application, "Contents", "Resources", "app.asar");
      const manifestBytes = fs.statSync(asar).isDirectory()
        ? fs.readFileSync(path.join(asar, "package.json"))
        : readAsarFile(asar, "package.json");
      const manifest = JSON.parse(manifestBytes.toString("utf8"));
      if (manifest.sourceCommit !== expectedCommit) {
        problems.push(`app.asar/package.json sourceCommit is ${manifest.sourceCommit || "missing"}, not ${expectedCommit}`);
      }
    } catch (error) {
      problems.push(`app.asar/package.json is unreadable: ${error.message}`);
    }
    if (problems.length > 0) {
      throw new Error(`The macOS package ${ours[0]} would not install under launchers already in use: ${problems.join("; ")}`);
    }
    return {
      archive: ours[0],
      application: path.basename(application),
      executable: LEGACY_EXECUTABLE_NAME,
      commit: expectedCommit,
      bundleName: readPlistValue(plist, "CFBundleName"),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = {
  LEGACY_ARCHIVE_PATTERN,
  LEGACY_BUNDLE_NAME,
  LEGACY_EXECUTABLE_NAME,
  SOURCE_COMMIT_KEY,
  checkMacUpdaterCompatibility,
  findSingleApplication,
  readAsarFile,
};
