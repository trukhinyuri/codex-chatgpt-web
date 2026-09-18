// The last step of scripts/package.cjs: move what electron-builder left in its staging folder to
// launcher/artifacts/, where installers, CI and the updaters of launchers already installed take it.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { checkMacUpdaterCompatibility } = require("./updater-compatibility.cjs");

const PACKAGE_FILE = /\.(?:AppImage|dmg|exe|zip|blockmap)$/i;
const DISTRIBUTABLE = /\.(?:AppImage|dmg|exe|zip)$/i;

/**
 * Replace the packages in `artifactsDirectory` with the ones in `staging` and return their names.
 * A macOS package must install under the updater of launchers already in use; one that would not is
 * removed again, together with everything published with it, and the error is thrown, so the build
 * fails once and leaves nothing an installed launcher could pick up.
 */
function publishArtifacts({
  staging,
  artifactsDirectory,
  target,
  arch = process.arch,
  sourceCommit,
  temporaryParent = os.tmpdir(),
  checkMacPackage = checkMacUpdaterCompatibility,
  log = message => process.stdout.write(`${message}\n`),
}) {
  fs.mkdirSync(artifactsDirectory, { recursive: true });
  for (const entry of fs.readdirSync(artifactsDirectory, { withFileTypes: true })) {
    if (entry.isFile() && PACKAGE_FILE.test(entry.name)) {
      fs.rmSync(path.join(artifactsDirectory, entry.name), { force: true });
    }
  }
  const artifacts = fs.readdirSync(staging, { withFileTypes: true })
    .filter(entry => entry.isFile() && PACKAGE_FILE.test(entry.name))
    .map(entry => entry.name)
    .sort();
  if (!artifacts.some(name => DISTRIBUTABLE.test(name))) {
    throw new Error(`electron-builder produced no distributable artifact in ${staging}`);
  }
  const published = [];
  try {
    for (const name of artifacts) {
      const publicName = name.replace(/-linux-x86_64(?=\.)/, "-linux-x64");
      fs.copyFileSync(path.join(staging, name), path.join(artifactsDirectory, publicName));
      published.push(publicName);
    }
    if (target === "--mac") {
      // Launchers already installed update themselves from what this step leaves in artifacts/.
      const checked = checkMacPackage({ artifactsDirectory, arch, expectedCommit: sourceCommit, temporaryParent });
      log(`Updater compatibility: ${checked.archive} -> ${checked.application} (CFBundleName ${checked.bundleName}, executable ${checked.executable}, commit ${checked.commit})`);
    }
  } catch (error) {
    for (const name of published) fs.rmSync(path.join(artifactsDirectory, name), { force: true });
    throw error;
  }
  return published;
}

module.exports = { publishArtifacts };
