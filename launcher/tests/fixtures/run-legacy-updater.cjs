// Plays the part of a launcher released at 86f2d311 installing a newer build: its own vendored updater
// checks, "builds" (the test supplies the package), stages and starts the worker, then exits the way the
// launcher quits so that the worker can replace the app. Usage: node run-legacy-updater.cjs <config.json>
const fs = require("node:fs");
const path = require("node:path");
const { createSourceUpdateController } = require("./updater-86f2d311/source-update.cjs");

async function main() {
  const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const result = { steps: [] };
  const record = () => fs.writeFileSync(config.resultPath, `${JSON.stringify(result, null, 2)}\n`);
  const controller = createSourceUpdateController({
    currentVersion: config.version,
    currentCommit: config.oldCommit,
    currentSourceState: "clean",
    platform: "darwin",
    arch: config.arch,
    packaged: true,
    executablePath: config.installedExecutable,
    runtimeExecutable: process.execPath,
    logsDirectory: config.logsDirectory,
    userDataDirectory: config.userData,
    sourceRoot: config.sourceRoot,
    healthTimeoutMs: config.healthTimeoutMs,
    dependencies: {
      fetchLatestCommit: async () => config.newCommit,
      fetchComparison: async () => ({ status: "ahead" }),
      fetchCheckRuns: async () => ({ check_runs: [] }),
      readLoginShellPath: async () => "",
      prepareCheckout: async () => {},
      // Each build step is recorded; "package the app" leaves the package the new scripts would produce.
      run: async (command, args) => {
        result.steps.push([command, ...args].join(" "));
        if (args.includes("app:package")) {
          const artifacts = path.join(config.sourceRoot, "launcher", "artifacts");
          fs.mkdirSync(artifacts, { recursive: true });
          fs.copyFileSync(config.packagePath, path.join(artifacts, config.packageName));
        }
      },
      stagingParent: config.stagingParent,
    },
  });
  result.check = await controller.checkOnce();
  let prepared;
  try {
    prepared = await controller.beginInstall({ automatic: true });
  } catch (error) {
    result.beginInstallError = error.message;
    record();
    return 3;
  }
  const job = JSON.parse(fs.readFileSync(prepared.jobPath, "utf8"));
  result.job = job;
  // The only change to the job: the worker would reopen the app with /usr/bin/open, and a test must
  // not register bundles with LaunchServices. It runs the installed executable directly instead.
  fs.writeFileSync(prepared.jobPath, `${JSON.stringify({ ...job, launchCommand: ["/bin/sh", path.join(job.target, "Contents", "MacOS", job.executableName)] })}\n`);
  try {
    await controller.launchInstall(prepared);
    result.workerStarted = fs.existsSync(path.join(prepared.tempRoot, "worker.started"));
  } catch (error) {
    result.launchError = error.message;
    result.workerStarted = fs.existsSync(path.join(prepared.tempRoot, "worker.started"));
    controller.cancelInstall(prepared);
    result.stageLeft = fs.existsSync(prepared.tempRoot);
    record();
    return 4;
  }
  record();
  return 0;
}

main().then(code => process.exit(code), (error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});
