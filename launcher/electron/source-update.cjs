const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

// This fork ships from source: the launcher updates itself from the main branch of the fork's
// GitHub repository and installs a new build only after the complete verification suite passes.
const SOURCE_REPOSITORY = "trukhinyuri/codex-chatgpt-web";
const SOURCE_BRANCH = "main";
const SOURCE_CLONE_URL = `https://github.com/${SOURCE_REPOSITORY}.git`;
const SOURCE_API_ROOT = `https://api.github.com/repos/${SOURCE_REPOSITORY}`;
const SOURCE_COMMIT_API_URL = `${SOURCE_API_ROOT}/commits/${SOURCE_BRANCH}`;
const SOURCE_CHECK_INTERVAL_MS = 60 * 60_000;
const SOURCE_STEP_TIMEOUT_MS = 45 * 60_000;
// The new launcher must report a healthy start within this window, or the worker restores the previous app.
const SOURCE_HEALTH_TIMEOUT_MS = 6 * 60_000;
const ROLLBACK_KEEP = 2;
const UPDATE_STATE_FILE = "source-update-state.json";
const STARTUP_HEALTH_FILE = "source-update-health.json";
const ROLLBACK_DIRECTORY = "rollback.noindex";
const MAX_FAILED_COMMITS = 20;
const USER_AGENT = "codex-web-gpt-launcher-source-updater";
const MAX_REDIRECTS = 5;
const COMMIT = /^[0-9a-f]{40}$/;

/** The managed checkout shared with scripts/install-fork-macos.sh. No spaces: build tools stay simple. */
function defaultSourceRoot(home = os.homedir()) {
  return path.join(home, ".codex-chatgpt-web-source");
}

function sourceUpdateVersion(appVersion, commit) {
  return `${appVersion}+${commit.slice(0, 7)}`;
}

/** Every build runs the repository's complete verification before it is packaged. */
function sourceBuildSteps() {
  return [
    { label: "install dependencies", command: "bun", args: ["install", "--frozen-lockfile"], cwd: "." },
    { label: "install launcher dependencies", command: "bun", args: ["install", "--frozen-lockfile"], cwd: "launcher" },
    { label: "run all tests (bun run verify)", command: "bun", args: ["run", "verify"], cwd: "." },
    { label: "package the app", command: "bun", args: ["run", "app:package"], cwd: "." },
  ];
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * GitHub check runs for a commit: "none" when the repository runs no CI for it, "pending" while any run
 * is unfinished, "failure" when any finished run did not pass, otherwise "success".
 */
function classifyCheckRuns(payload) {
  const runs = Array.isArray(payload?.check_runs) ? payload.check_runs : [];
  if (runs.length === 0) return "none";
  if (runs.some(run => run?.status !== "completed")) return "pending";
  const passed = new Set(["success", "neutral", "skipped"]);
  return runs.every(run => passed.has(run?.conclusion)) ? "success" : "failure";
}

/** GitHub compare installed...main: "ahead" means main only adds commits on top of the installed build. */
function classifyComparison(payload) {
  const status = payload?.status;
  return ["ahead", "behind", "diverged", "identical"].includes(status) ? status : "unknown";
}

/**
 * Why an available commit must not install by itself, or null. Automatic updates only fast-forward a
 * clean build of main to a commit that has not failed here before and whose CI (if any) passed.
 */
function automaticUpdateBlocker({ sourceState, relation, ci, failedBefore }) {
  if (sourceState !== "clean") return "local-build";
  if (relation !== "ahead") return `history-${relation}`;
  if (failedBefore) return "failed-before";
  if (ci !== "success" && ci !== "none") return `ci-${ci}`;
  return null;
}

function emptyUpdateState() {
  return { version: 1, failedCommits: {}, lastResult: null };
}

/** Shared with the update worker and the rollback script: which commits failed here, and the last outcome. */
function readUpdateState(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (parsed?.version === 1 && parsed.failedCommits && typeof parsed.failedCommits === "object") {
      return { ...emptyUpdateState(), ...parsed };
    }
  } catch {}
  return emptyUpdateState();
}

function recordFailedCommit(filePath, commit, { stage, reason, at = new Date().toISOString() }) {
  const state = readUpdateState(filePath);
  const failure = { at, stage, reason: String(reason || "").slice(0, 500) };
  const failedCommits = Object.entries({ ...state.failedCommits, [commit]: failure })
    .sort(([, left], [, right]) => String(right?.at || "").localeCompare(String(left?.at || "")))
    .slice(0, MAX_FAILED_COMMITS);
  const next = { ...state, failedCommits: Object.fromEntries(failedCommits), lastResult: { commit, result: "failed", ...failure } };
  writePrivateFileAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/**
 * The launcher reports how its start went. After an update the worker waits for "healthy" from the new
 * commit and restores the previous app on "unhealthy", on a crash during startup, or on silence.
 */
function writeStartupHealth(filePath, { commit, status, reason = null, pid = process.pid, at = new Date() }) {
  try {
    writePrivateFileAtomic(filePath, `${JSON.stringify({ version: 1, commit, pid, status, reason, at: at.toISOString() })}\n`);
    return true;
  } catch {
    return false;
  }
}

function applicationBundle(executablePath) {
  const bundle = path.resolve(executablePath, "..", "..", "..");
  if (!bundle.endsWith(".app")) throw new Error(`The launcher is not running from an application bundle: ${executablePath}`);
  return bundle;
}

function normalizedRemote(url) {
  return String(url || "").trim().replace(/\/+$/, "").replace(/\.git$/, "").toLowerCase();
}

/** Put the launcher's pinned Bun first, then the user's login-shell tools (git, node). */
function sourceBuildPath({ runtimeExecutable, loginShellPath = "", inheritedPath = "" }) {
  const entries = [
    path.dirname(runtimeExecutable),
    ...String(loginShellPath).split(path.delimiter),
    ...String(inheritedPath).split(path.delimiter),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  return [...new Set(entries.map(entry => entry.trim()).filter(Boolean))].join(path.delimiter);
}

function readLoginShellPath() {
  const shell = process.env.SHELL && path.isAbsolute(process.env.SHELL) ? process.env.SHELL : "/bin/zsh";
  const marker = "__CODEX_WEB_GPT_PATH__";
  return new Promise((resolve) => {
    // A GUI app inherits launchd's minimal PATH; the login shell knows where git and node live.
    const child = spawn(shell, ["-ilc", `printf '${marker}%s${marker}' "$PATH"`], { stdio: ["ignore", "pipe", "ignore"] });
    const chunks = [];
    const timer = setTimeout(() => child.kill("SIGTERM"), 15_000);
    child.stdout.on("data", chunk => chunks.push(chunk));
    child.once("error", () => { clearTimeout(timer); resolve(""); });
    child.once("close", () => {
      clearTimeout(timer);
      const match = new RegExp(`${marker}([\\s\\S]*?)${marker}`).exec(Buffer.concat(chunks).toString("utf8"));
      resolve(match ? match[1] : "");
    });
  });
}

function requestJson(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > MAX_REDIRECTS) {
      reject(new Error(`Too many redirects while checking ${url}`));
      return;
    }
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      reject(new Error(`Refusing non-HTTPS update URL: ${parsed.protocol}`));
      return;
    }
    const req = https.get(parsed, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": USER_AGENT },
    }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        requestJson(new URL(response.headers.location, parsed).toString(), redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`GitHub update check failed with HTTP ${response.statusCode}`));
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) response.destroy(new Error("GitHub update metadata exceeded its size limit"));
        else chunks.push(chunk);
      });
      response.once("error", reject);
      response.once("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.setTimeout(60_000, () => req.destroy(new Error("GitHub update check timed out")));
    req.once("error", reject);
  });
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * One build at a time across the launcher and the terminal installer. The owner records its PID; a
 * lock whose owner is gone is reclaimed, and a fresh lock without a PID yet is treated as held.
 */
function acquireLock(lockPath, now = Date.now()) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      fs.writeFileSync(path.join(lockPath, "pid"), `${process.pid}\n`, { mode: 0o600 });
      return lockPath;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    let owner = Number.NaN;
    try { owner = Number.parseInt(fs.readFileSync(path.join(lockPath, "pid"), "utf8"), 10); } catch {}
    let ageMs = 0;
    try { ageMs = now - fs.statSync(lockPath).mtimeMs; } catch { continue; }
    const held = Number.isInteger(owner) && owner > 0 ? processAlive(owner) : ageMs < 60_000;
    if (held) {
      throw new Error(`Another source update or install is running${Number.isInteger(owner) ? ` (PID ${owner})` : ""}`);
    }
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
  throw new Error(`Could not acquire the source update lock at ${lockPath}`);
}

function releaseLock(lockPath) {
  if (lockPath) fs.rmSync(lockPath, { recursive: true, force: true });
}

function appendLog(logPath, line) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
  } catch {}
}

/**
 * Builds and tests run at low CPU priority: they share the machine with the launcher's ChatGPT tabs,
 * and a starved renderer makes live turns time out while an update is being prepared.
 */
function lowPriorityCommand(command, args) {
  return { command: "/usr/bin/nice", args: ["-n", "15", command, ...args] };
}

function run(command, args, { cwd, env, log, timeoutMs = SOURCE_STEP_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    log?.(`$ ${[command, ...args].join(" ")} (in ${cwd})`);
    const niced = lowPriorityCommand(command, args);
    const child = spawn(niced.command, niced.args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    const forward = (chunk) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) if (line.trim()) log?.(line);
    };
    child.stdout.on("data", forward);
    child.stderr.on("data", forward);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
    });
  });
}

function git(args, { env }) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const out = [];
    const err = [];
    const timer = setTimeout(() => child.kill("SIGTERM"), 10 * 60_000);
    child.stdout.on("data", chunk => out.push(chunk));
    child.stderr.on("data", chunk => err.push(chunk));
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out).toString("utf8").trim());
      else reject(new Error(`git ${args.join(" ")} failed: ${Buffer.concat(err).toString("utf8").trim()}`));
    });
  });
}

/** Check out exactly the verified commit in the managed clone; nothing local survives except ignored caches. */
async function prepareCheckout({ sourceRoot, commit, env, log, cloneUrl = SOURCE_CLONE_URL, branch = SOURCE_BRANCH }) {
  if (!COMMIT.test(commit)) throw new Error(`Refusing to build an invalid commit: ${commit}`);
  if (!fs.existsSync(path.join(sourceRoot, ".git"))) {
    if (fs.existsSync(sourceRoot) && fs.readdirSync(sourceRoot).length > 0) {
      throw new Error(`${sourceRoot} exists but is not a Git checkout; move it away and retry`);
    }
    fs.mkdirSync(path.dirname(sourceRoot), { recursive: true });
    log?.(`cloning ${cloneUrl} into ${sourceRoot}`);
    await git(["clone", "--quiet", "--no-tags", "--branch", branch, cloneUrl, sourceRoot], { env });
  }
  const origin = await git(["-C", sourceRoot, "remote", "get-url", "origin"], { env });
  if (normalizedRemote(origin) !== normalizedRemote(cloneUrl)) {
    throw new Error(`${sourceRoot} tracks ${origin}, not ${cloneUrl}`);
  }
  await git(["-C", sourceRoot, "fetch", "--quiet", "--no-tags", "origin", branch], { env });
  await git(["-C", sourceRoot, "merge-base", "--is-ancestor", commit, `origin/${branch}`], { env });
  await git(["-C", sourceRoot, "checkout", "--quiet", "--force", "--detach", commit], { env });
  await git(["-C", sourceRoot, "reset", "--quiet", "--hard", commit], { env });
  await git(["-C", sourceRoot, "clean", "--quiet", "-fd"], { env });
  const head = await git(["-C", sourceRoot, "rev-parse", "HEAD"], { env });
  if (head !== commit) throw new Error(`Managed checkout is at ${head}, expected ${commit}`);
  log?.(`checked out ${commit}`);
}

function findPackage(sourceRoot, arch, notBefore) {
  const artifacts = path.join(sourceRoot, "launcher", "artifacts");
  const candidates = fs.existsSync(artifacts)
    ? fs.readdirSync(artifacts)
      .filter(name => new RegExp(`^codex-web-gpt-.+-mac-${arch}\\.zip$`).test(name))
      .map(name => path.join(artifacts, name))
      .filter(file => fs.statSync(file).mtimeMs >= notBefore)
    : [];
  if (candidates.length !== 1) {
    throw new Error(`Expected one fresh macOS ${arch} package in ${artifacts}; found ${candidates.length}`);
  }
  return candidates[0];
}

function readPackagedCommit(application) {
  // Electron's fs reads inside app.asar; a package without the stamp is not a build of this fork.
  const manifest = JSON.parse(fs.readFileSync(path.join(application, "Contents", "Resources", "app.asar", "package.json"), "utf8"));
  return manifest.sourceCommit;
}

function findMacApplication(root) {
  const entry = fs.readdirSync(root, { withFileTypes: true }).find(item => item.isDirectory() && item.name.endsWith(".app"));
  if (!entry) throw new Error("The built macOS package does not contain an application bundle");
  return path.join(root, entry.name);
}

function defaultDependencies() {
  return {
    fetchLatestCommit: async () => (await requestJson(SOURCE_COMMIT_API_URL))?.sha,
    fetchComparison: async (base, head) => requestJson(`${SOURCE_API_ROOT}/compare/${base}...${head}`),
    fetchCheckRuns: async commit => requestJson(`${SOURCE_API_ROOT}/commits/${commit}/check-runs?per_page=100`),
    readLoginShellPath,
    acquireLock,
    releaseLock,
    appendLog,
    prepareCheckout,
    run,
    findPackage,
    extractMac(archive, destination) {
      fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
      const result = spawnSync("/usr/bin/ditto", ["-x", "-k", archive, destination], { encoding: "utf8", timeout: 180_000 });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`Could not extract the built package: ${result.stderr.trim()}`);
    },
    readPackagedCommit(stagingRoot) {
      return readPackagedCommit(findMacApplication(stagingRoot));
    },
    spawnWorker(runtimeExecutable, workerPath, jobPath) {
      return spawn(runtimeExecutable, [workerPath, jobPath], { detached: true, stdio: "ignore", windowsHide: true });
    },
    now: () => Date.now(),
  };
}

function createSourceUpdateController({
  currentVersion,
  currentCommit,
  currentSourceState = "clean",
  platform,
  arch,
  packaged,
  executablePath,
  runtimeExecutable,
  logsDirectory,
  userDataDirectory,
  sourceRoot = defaultSourceRoot(),
  healthTimeoutMs = SOURCE_HEALTH_TIMEOUT_MS,
  publish,
  logger,
  dependencies = {},
}) {
  const deps = { ...defaultDependencies(), ...dependencies };
  const supported = Boolean(packaged)
    && platform === "darwin"
    && ["arm64", "x64"].includes(arch)
    && COMMIT.test(String(currentCommit || ""))
    && typeof runtimeExecutable === "string" && path.isAbsolute(runtimeExecutable)
    && typeof userDataDirectory === "string" && path.isAbsolute(userDataDirectory);
  let state = supported ? { status: "idle" } : { status: "disabled" };
  let candidate = null;
  let checking = null;
  let pending = null;
  const logPath = path.join(logsDirectory, "source-update.log");
  const statePath = supported ? path.join(userDataDirectory, UPDATE_STATE_FILE) : null;
  const healthPath = supported ? path.join(userDataDirectory, STARTUP_HEALTH_FILE) : null;

  if (supported) {
    // Surface what the previous update did: a rollback is a problem the maintainer needs to hear about.
    const last = readUpdateState(statePath).lastResult;
    if (last?.result === "rolled-back" && last.commit !== currentCommit) {
      logger?.warn("launcher.update_rolled_back", { commit: last.commit, stage: last.stage, at: last.at, channel: "source" });
    }
  }

  const transition = (next) => {
    state = next;
    publish?.(state);
    return state;
  };

  const availableState = target => ({
    status: "available",
    version: target.version,
    automatic: target.automatic === true,
    ...(target.blocked ? { blocked: target.blocked } : {}),
  });

  /** The candidate an unattended update may install now, or null. */
  function automaticCandidate() {
    return state.status === "available" && candidate?.automatic === true && !pending ? candidate : null;
  }

  function checkOnce() {
    if (state.status === "disabled" || pending || state.status === "installing" || state.status === "downloading") {
      return Promise.resolve(state);
    }
    if (checking) return checking;
    checking = (async () => {
      transition({ status: "checking" });
      try {
        const commit = await deps.fetchLatestCommit();
        if (!COMMIT.test(String(commit || ""))) throw new Error(`GitHub returned an invalid ${SOURCE_BRANCH} commit`);
        if (commit === currentCommit && currentSourceState === "clean") {
          candidate = null;
          return transition({ status: "up-to-date" });
        }
        // A failed lookup blocks automatic installation for now; it never makes a commit look safe.
        const relation = commit === currentCommit
          ? "identical"
          : await deps.fetchComparison(currentCommit, commit).then(classifyComparison, () => "unknown");
        if (relation === "behind") {
          // This build already contains main and more (a maintainer's local build): never downgrade it.
          candidate = null;
          logger?.info("launcher.update_local_build_newer", { currentCommit, commit, channel: "source" });
          return transition({ status: "up-to-date" });
        }
        const ci = await deps.fetchCheckRuns(commit).then(classifyCheckRuns, () => "unknown");
        const failedBefore = Boolean(readUpdateState(statePath).failedCommits[commit]);
        const blocked = automaticUpdateBlocker({ sourceState: currentSourceState, relation, ci, failedBefore });
        candidate = { commit, version: sourceUpdateVersion(currentVersion, commit), automatic: blocked === null, blocked };
        logger?.info("launcher.update_available", { currentCommit, commit, relation, ci, blocked, channel: "source" });
        return transition({
          status: "available",
          version: candidate.version,
          automatic: candidate.automatic,
          ...(blocked ? { blocked } : {}),
        });
      } catch (error) {
        const message = errorMessage(error);
        logger?.warn("launcher.update_check_failed", { message, channel: "source" });
        return transition(candidate ? availableState(candidate) : { status: "error", message });
      } finally {
        checking = null;
      }
    })();
    return checking;
  }

  /**
   * Build the exact announced commit, run the complete verification, package and stage it. Nothing
   * is replaced here: the caller launches the prepared install only when Codex has no active turns.
   */
  async function beginInstall({ automatic = false } = {}) {
    if (pending) throw new Error("An update is already being prepared");
    if (state.status !== "available" || !candidate) throw new Error("No launcher update is available");
    if (automatic && candidate.automatic !== true) throw new Error(`Update to ${candidate.version} needs a manual install`);
    const target = candidate;
    pending = (async () => {
      transition({ status: "downloading", version: target.version, automatic });
      const log = line => deps.appendLog(logPath, line);
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-update-"));
      let lock = null;
      try {
        lock = deps.acquireLock(`${sourceRoot}.lock`);
        log(`source update ${currentCommit} -> ${target.commit} from ${SOURCE_CLONE_URL}`);
        const env = {
          ...process.env,
          PATH: sourceBuildPath({
            runtimeExecutable,
            loginShellPath: await deps.readLoginShellPath(),
            inheritedPath: process.env.PATH,
          }),
        };
        await deps.prepareCheckout({ sourceRoot, commit: target.commit, env, log });
        const startedAt = deps.now();
        for (const step of sourceBuildSteps()) {
          log(`step: ${step.label}`);
          try {
            await deps.run(step.command, step.args, { cwd: path.join(sourceRoot, step.cwd), env, log });
          } catch (error) {
            throw new Error(`${step.label} failed: ${errorMessage(error)}`);
          }
        }
        const archive = deps.findPackage(sourceRoot, arch, startedAt);
        const stagingRoot = path.join(tempRoot, "stage");
        deps.extractMac(archive, stagingRoot);
        const builtCommit = deps.readPackagedCommit(stagingRoot);
        if (builtCommit !== target.commit) {
          throw new Error(`The package was built from ${builtCommit || "an unknown commit"}, not ${target.commit}`);
        }
        // The worker replaces the app, keeps the previous one for rollback and waits for a healthy start.
        const workerPath = path.join(tempRoot, "source-update-worker.cjs");
        fs.copyFileSync(path.join(__dirname, "source-update-worker.cjs"), workerPath);
        const job = {
          version: 1,
          parentPid: process.pid,
          source: findMacApplication(stagingRoot),
          target: applicationBundle(executablePath),
          executableName: path.basename(executablePath),
          commit: target.commit,
          previousCommit: currentCommit,
          displayVersion: target.version,
          rollbackRoot: path.join(userDataDirectory, ROLLBACK_DIRECTORY),
          rollbackKeep: ROLLBACK_KEEP,
          healthPath,
          healthTimeoutMs,
          statePath,
          logPath,
          tempRoot,
        };
        const jobPath = path.join(tempRoot, "job.json");
        fs.writeFileSync(jobPath, `${JSON.stringify(job)}\n`, { mode: 0o600 });
        log(`verified and staged ${target.commit}; waiting for Codex to be idle`);
        logger?.info("launcher.update_prepared", { commit: target.commit, automatic, channel: "source" });
        transition({ status: "installing", version: target.version, automatic, waitingForIdle: true });
        return { tempRoot, workerPath, jobPath, version: target.version, commit: target.commit };
      } catch (error) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
        log(`update to ${target.commit} failed: ${errorMessage(error)}`);
        logger?.warn("launcher.update_failed", { commit: target.commit, automatic, message: errorMessage(error), channel: "source" });
        // Remember the failure: an unattended update never retries this commit; a manual one may.
        try { recordFailedCommit(statePath, target.commit, { stage: "build", reason: errorMessage(error) }); } catch {}
        candidate = { ...target, automatic: false, blocked: "failed-before" };
        transition(availableState(candidate));
        throw new Error(`Update to ${target.version} was not installed: ${errorMessage(error)}. Details: ${logPath}`);
      } finally {
        deps.releaseLock(lock);
      }
    })();
    try {
      return await pending;
    } finally {
      pending = null;
    }
  }

  /** Start the detached worker that replaces the app after this launcher exits. */
  function launchInstall(prepared) {
    const child = deps.spawnWorker(runtimeExecutable, prepared.workerPath, prepared.jobPath);
    if (!Number.isInteger(child?.pid) || child.pid <= 0) throw new Error("The update worker did not start");
    child.unref?.();
    logger?.info("launcher.update_worker_started", { pid: child.pid, version: prepared.version, channel: "source" });
    return { child, prepared };
  }

  /** Stop a worker whose launcher did not exit; the staged build stays ready for the next idle window. */
  function abortLaunch(launch) {
    try { launch?.child?.kill(); } catch {}
  }

  function cancelInstall(prepared) {
    if (prepared?.tempRoot) fs.rmSync(prepared.tempRoot, { recursive: true, force: true });
    if (candidate) transition(availableState(candidate));
  }

  return {
    channel: "source",
    getState: () => state,
    automaticCandidate,
    checkOnce,
    beginInstall,
    launchInstall,
    abortLaunch,
    cancelInstall,
  };
}

module.exports = {
  COMMIT,
  ROLLBACK_DIRECTORY,
  ROLLBACK_KEEP,
  SOURCE_API_ROOT,
  SOURCE_BRANCH,
  SOURCE_CHECK_INTERVAL_MS,
  SOURCE_CLONE_URL,
  SOURCE_COMMIT_API_URL,
  SOURCE_HEALTH_TIMEOUT_MS,
  SOURCE_REPOSITORY,
  STARTUP_HEALTH_FILE,
  UPDATE_STATE_FILE,
  acquireLock,
  applicationBundle,
  automaticUpdateBlocker,
  classifyCheckRuns,
  classifyComparison,
  createSourceUpdateController,
  defaultSourceRoot,
  lowPriorityCommand,
  prepareCheckout,
  readUpdateState,
  recordFailedCommit,
  releaseLock,
  sourceBuildPath,
  sourceBuildSteps,
  sourceUpdateVersion,
  writeStartupHealth,
};
