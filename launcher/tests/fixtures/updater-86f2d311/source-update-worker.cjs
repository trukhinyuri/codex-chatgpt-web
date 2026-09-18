// Replaces the launcher with a verified build of this fork, keeps the previous app for rollback and
// restores it when the new launcher does not report a healthy start. It runs detached from the
// launcher (which must exit first) and is copied next to its job, so it depends on Node built-ins only.
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const HEALTH_POLL_MS = 1_000;
const PARENT_EXIT_TIMEOUT_MS = 120_000;
const STOP_TIMEOUT_MS = 30_000;

function appendLog(job, message) {
  try {
    fs.mkdirSync(path.dirname(job.logPath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(job.logPath, `${new Date().toISOString()} worker: ${message}\n`, { mode: 0o600 });
  } catch {}
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(250);
  }
  return true;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

/** Same format as readUpdateState/recordFailedCommit in source-update.cjs. */
function recordResult(job, result, { stage = null, reason = null } = {}) {
  const current = readJson(job.statePath);
  const state = current?.version === 1 && current.failedCommits && typeof current.failedCommits === "object"
    ? current
    : { version: 1, failedCommits: {}, lastResult: null };
  const at = new Date().toISOString();
  const outcome = { commit: job.commit, result, at, stage, reason: reason ? String(reason).slice(0, 500) : null };
  if (result !== "installed") {
    state.failedCommits = Object.fromEntries(Object.entries({
      ...state.failedCommits,
      [job.commit]: { at, stage, reason: outcome.reason },
    }).sort(([, left], [, right]) => String(right?.at || "").localeCompare(String(left?.at || ""))).slice(0, 20));
  }
  state.lastResult = outcome;
  try { writeJsonAtomic(job.statePath, state); } catch (error) { appendLog(job, `could not record the result: ${errorText(error)}`); }
}

/** rename(2) on the same volume; a copy and delete when the rollback store lives on another one. */
function moveDirectory(source, destination) {
  try {
    fs.renameSync(source, destination);
    return;
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
  }
  const copied = spawnSync("/usr/bin/ditto", [source, destination], { encoding: "utf8", timeout: 600_000 });
  if (copied.error) throw copied.error;
  if (copied.status !== 0) throw new Error(`Could not copy ${source}: ${copied.stderr.trim()}`);
  fs.rmSync(source, { recursive: true, force: true });
}

function executableOf(job, application) {
  return path.join(application, "Contents", "MacOS", job.executableName);
}

function requireExecutable(file, label) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`${label} is missing: ${file}`);
}

/** Copy the staged build next to the installed app (same volume) so the swap is two renames. */
function stageNextToTarget(job) {
  const next = `${job.target}.updating-${process.pid}`;
  fs.rmSync(next, { recursive: true, force: true });
  const copied = spawnSync("/usr/bin/ditto", [job.source, next], { encoding: "utf8", timeout: 600_000 });
  if (copied.error) throw copied.error;
  if (copied.status !== 0) throw new Error(`Could not stage the new application: ${copied.stderr.trim()}`);
  requireExecutable(executableOf(job, next), "Staged launcher executable");
  const stamp = spawnSync("/usr/bin/plutil", [
    "-extract", "CodexWebGptSourceCommit", "raw", "-o", "-", path.join(next, "Contents", "Info.plist"),
  ], { encoding: "utf8", timeout: 30_000 });
  if (stamp.status === 0 && stamp.stdout.trim() !== job.commit) {
    fs.rmSync(next, { recursive: true, force: true });
    throw new Error(`The staged application is ${stamp.stdout.trim()}, not ${job.commit}`);
  }
  return next;
}

function rollbackEntries(job) {
  try {
    return fs.readdirSync(job.rollbackRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^\d{8}T\d{6}Z-/.test(entry.name))
      .map(entry => entry.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** Move the installed app into the rollback store as <UTC time>-<commit>/<App name>.app. */
function saveInstalledApp(job) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const entry = path.join(job.rollbackRoot, `${stamp}-${String(job.previousCommit || "unknown").slice(0, 12)}`);
  fs.mkdirSync(entry, { recursive: true, mode: 0o700 });
  const saved = path.join(entry, path.basename(job.target));
  moveDirectory(job.target, saved);
  writeJsonAtomic(path.join(entry, "meta.json"), {
    version: 1,
    commit: job.previousCommit || null,
    replacedBy: job.commit,
    savedAt: new Date().toISOString(),
    source: "launcher-update",
  });
  return { entry, saved };
}

function pruneRollbackStore(job, keep) {
  for (const name of rollbackEntries(job).slice(Math.max(1, keep))) {
    fs.rmSync(path.join(job.rollbackRoot, name), { recursive: true, force: true });
    appendLog(job, `removed old rollback copy ${name}`);
  }
}

function launchApplication(job) {
  const [command, ...args] = Array.isArray(job.launchCommand) && job.launchCommand.length > 0
    ? job.launchCommand
    : ["/usr/bin/open", job.target];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

/** Resolves once the new commit reports healthy, or with the reason it did not. */
async function waitForHealthyStart(job) {
  const deadline = Date.now() + job.healthTimeoutMs;
  while (Date.now() < deadline) {
    const health = readJson(job.healthPath);
    if (health?.commit === job.commit) {
      if (health.status === "healthy") return { ok: true };
      if (health.status === "unhealthy") return { ok: false, pid: health.pid, reason: `startup failed (${health.reason || "unknown"})` };
      if (health.status === "starting" && !processAlive(health.pid)) {
        return { ok: false, pid: null, reason: "the new launcher exited during startup" };
      }
    }
    await sleep(HEALTH_POLL_MS);
  }
  const health = readJson(job.healthPath);
  return {
    ok: false,
    pid: health?.commit === job.commit ? health.pid : null,
    reason: `no healthy start within ${Math.round(job.healthTimeoutMs / 1000)} s`,
  };
}

function launcherPids(job) {
  const listed = spawnSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8", timeout: 30_000 });
  if (listed.status !== 0) return [];
  const prefix = executableOf(job, job.target);
  return listed.stdout.split("\n")
    .map(line => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter(match => match && match[2].startsWith(prefix))
    .map(match => Number.parseInt(match[1], 10))
    .filter(pid => pid !== process.pid);
}

async function stopNewLauncher(job, pidHint) {
  const pids = [...new Set([pidHint, ...launcherPids(job)].filter(pid => processAlive(pid)))];
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  for (const pid of pids) {
    if (!(await waitForExit(pid, STOP_TIMEOUT_MS))) {
      try { process.kill(pid, "SIGKILL"); } catch {}
      await waitForExit(pid, 5_000);
    }
  }
}

async function rollBack(job, saved, reason) {
  appendLog(job, `rolling back ${job.commit}: ${reason}`);
  await stopNewLauncher(job, saved.pid);
  const failed = `${job.target}.failed-${process.pid}`;
  fs.rmSync(failed, { recursive: true, force: true });
  if (fs.existsSync(job.target)) moveDirectory(job.target, failed);
  moveDirectory(saved.saved, job.target);
  fs.rmSync(saved.entry, { recursive: true, force: true });
  fs.rmSync(failed, { recursive: true, force: true });
  recordResult(job, "rolled-back", { stage: "startup", reason });
  launchApplication(job);
  appendLog(job, `restored ${job.previousCommit || "the previous build"} and relaunched it`);
}

async function main() {
  const jobPath = process.argv[2];
  if (!jobPath || !path.isAbsolute(jobPath)) throw new Error("The update worker requires an absolute job path");
  const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
  if (job?.version !== 1) throw new Error("Unsupported update job");
  job.healthTimeoutMs = Number.isFinite(job.healthTimeoutMs) && job.healthTimeoutMs > 0 ? job.healthTimeoutMs : 6 * 60_000;
  requireExecutable(executableOf(job, job.source), "Staged launcher executable");
  // The launcher quits only after this marker appears: a worker that cannot read its job or its
  // staged app never leaves Codex without a launcher.
  fs.writeFileSync(path.join(job.tempRoot, "worker.started"), `${process.pid}\n`, { mode: 0o600 });
  appendLog(job, `waiting for launcher PID ${job.parentPid} to exit before installing ${job.displayVersion}`);
  if (!(await waitForExit(job.parentPid, PARENT_EXIT_TIMEOUT_MS))) {
    appendLog(job, "the launcher did not exit; nothing was changed");
    return 1;
  }

  let saved = null;
  try {
    const next = stageNextToTarget(job);
    try {
      saved = saveInstalledApp(job);
      moveDirectory(next, job.target);
    } catch (error) {
      fs.rmSync(next, { recursive: true, force: true });
      if (saved && !fs.existsSync(job.target)) moveDirectory(saved.saved, job.target);
      if (saved) fs.rmSync(saved.entry, { recursive: true, force: true });
      saved = null;
      throw error;
    }
  } catch (error) {
    appendLog(job, `install failed, the installed app is unchanged: ${errorText(error)}`);
    recordResult(job, "failed", { stage: "install", reason: errorText(error) });
    if (fs.existsSync(job.target)) launchApplication(job);
    try { fs.rmSync(job.tempRoot, { recursive: true, force: true }); } catch {}
    return 1;
  }

  fs.rmSync(job.healthPath, { force: true });
  appendLog(job, `installed ${job.commit}; waiting for a healthy start`);
  launchApplication(job);
  const health = await waitForHealthyStart(job);
  if (health.ok) {
    recordResult(job, "installed");
    pruneRollbackStore(job, job.rollbackKeep);
    appendLog(job, `${job.displayVersion} started healthy; previous build kept in ${saved.entry}`);
    try { fs.rmSync(job.tempRoot, { recursive: true, force: true }); } catch {}
    return 0;
  }
  try {
    await rollBack(job, { ...saved, pid: health.pid }, health.reason);
  } catch (error) {
    appendLog(job, `ROLLBACK FAILED: ${errorText(error)}. The previous app is in ${saved.entry}`);
    recordResult(job, "failed", { stage: "rollback", reason: errorText(error) });
    return 1;
  }
  try { fs.rmSync(job.tempRoot, { recursive: true, force: true }); } catch {}
  return 1;
}

void main().then(code => process.exit(code), () => process.exit(1));
