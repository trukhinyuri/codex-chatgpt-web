const nodeTest = require("node:test");
// Source updates exist only in packaged macOS builds (the controller disables itself elsewhere, and a
// test below checks that); their paths and processes are macOS paths and processes.
const test = process.platform === "win32"
  ? (name, ...rest) => nodeTest(name, { skip: "source updates are macOS-only" }, typeof rest.at(-1) === "function" ? rest.at(-1) : () => {})
  : nodeTest;
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  LEGACY_SOURCE_CLONE_URLS,
  SOURCE_BRANCH,
  SOURCE_CLONE_URL,
  SOURCE_COMMIT_API_URL,
  acquireLock,
  applicationBundle,
  automaticUpdateBlocker,
  classifyCheckRuns,
  classifyComparison,
  createSourceUpdateController,
  defaultSourceRoot,
  lowPriorityCommand,
  prepareCheckout,
  isTransientBuildFailure,
  prepareBuildHome,
  sourceBuildEnvironment,
  sourceBuildHome,
  readUpdateState,
  recordFailedCommit,
  releaseLock,
  sourceBuildPath,
  sourceBuildSteps,
  sourceUpdateVersion,
  writeStartupHealth,
} = require("../electron/source-update.cjs");
const { createTurnOutcomeLog, updateQuietWindow, SHORT_QUIET_MS, LONG_WAIT_MS } = require("../electron/update-idle-policy.cjs");

const INSTALLED = "1".repeat(40);
const MAIN = "2".repeat(40);

const tempDirs = [];
test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function controller(overrides = {}, dependencies = {}) {
  const logs = tempDir("cwg-source-logs-");
  const published = [];
  const calls = [];
  const instance = createSourceUpdateController({
    currentVersion: "5.0.8",
    currentCommit: INSTALLED,
    platform: "darwin",
    arch: "arm64",
    packaged: true,
    executablePath: "/Applications/Codex Web GPT.app/Contents/MacOS/Codex Web GPT",
    runtimeExecutable: "/runtime/bun-root/runtime/bun",
    logsDirectory: logs,
    userDataDirectory: logs,
    sourceRoot: path.join(logs, "source"),
    publish: state => published.push(state),
    logger: { info: () => {}, warn: (event, fields) => calls.push(["warn", event, fields]) },
    ...overrides,
    dependencies: {
      stagingParent: logs,
      fetchLatestCommit: async () => MAIN,
      fetchComparison: async () => ({ status: "ahead" }),
      fetchCheckRuns: async () => ({ total_count: 0, check_runs: [] }),
      readLoginShellPath: async () => "/opt/homebrew/bin:/usr/bin",
      acquireLock: lockPath => { calls.push(["lock", lockPath]); return lockPath; },
      releaseLock: lockPath => calls.push(["unlock", lockPath]),
      appendLog: () => {},
      prepareCheckout: async ({ commit, env }) => calls.push(["checkout", commit, env.PATH]),
      prepareBuildHome: () => {
        const buildHome = path.join(logs, "build-home");
        fs.mkdirSync(buildHome, { recursive: true });
        return buildHome;
      },
      run: async (command, args, { cwd }) => calls.push(["run", command, args.join(" "), path.basename(cwd)]),
      findPackage: () => path.join(logs, "codex-web-gpt-5.0.8-mac-arm64.zip"),
      extractMac: (_archive, destination) => {
        fs.mkdirSync(path.join(destination, "Codex Web GPT.app", "Contents", "MacOS"), { recursive: true });
        fs.writeFileSync(path.join(destination, "Codex Web GPT.app", "Contents", "MacOS", "Codex Web GPT"), "");
      },
      readPackagedCommit: () => MAIN,
      spawnWorker: (_runtime, workerPath, jobPath) => {
        calls.push(["worker", path.basename(workerPath), path.basename(jobPath)]);
        // The real worker confirms that it read its job before the launcher may quit.
        fs.writeFileSync(path.join(path.dirname(workerPath), "worker.started"), "4242\n");
        return { pid: 4242, unref() {}, kill() { calls.push(["kill"]); } };
      },
      now: () => 0,
      ...dependencies,
    },
  });
  return { instance, published, calls, logs };
}

test("the fork updates only from its own main branch", () => {
  assert.equal(SOURCE_BRANCH, "main");
  assert.equal(SOURCE_CLONE_URL, "https://github.com/trukhinyuri/codex-superpower.git");
  assert.equal(SOURCE_COMMIT_API_URL, "https://api.github.com/repos/trukhinyuri/codex-superpower/commits/main");
  assert.equal(defaultSourceRoot("/Users/example"), "/Users/example/.codex-chatgpt-web-source");
  assert.equal(sourceUpdateVersion("5.0.8", MAIN), "5.0.8+2222222");
});

test("every source build runs the complete verification before packaging", () => {
  const steps = sourceBuildSteps().map(step => `${step.command} ${step.args.join(" ")} @${step.cwd}`);
  assert.deepEqual(steps, [
    "bun install --frozen-lockfile @.",
    "bun install --frozen-lockfile @launcher",
    "bun run verify @.",
    "bun run app:package @.",
  ]);
});

test("builds and tests run at low CPU priority beside live ChatGPT turns", () => {
  assert.deepEqual(lowPriorityCommand("bun", ["run", "verify"]), {
    command: "/usr/bin/nice",
    args: ["-n", "15", "bun", "run", "verify"],
  });
  assert.ok(fs.existsSync("/usr/bin/nice") || process.platform !== "darwin");
});

test("the build uses the launcher's pinned Bun before any other tool on PATH", () => {
  const value = sourceBuildPath({
    runtimeExecutable: "/runtime/root/runtime/bun",
    loginShellPath: "/opt/homebrew/bin:/Users/example/.bun/bin",
    inheritedPath: "/usr/bin:/bin",
  });
  const entries = value.split(path.delimiter);
  assert.equal(entries[0], "/runtime/root/runtime");
  assert.ok(entries.indexOf("/opt/homebrew/bin") < entries.indexOf("/usr/bin"));
  assert.equal(new Set(entries).size, entries.length);
});

test("source updates stay disabled outside a stamped packaged macOS build", async () => {
  for (const overrides of [
    { packaged: false },
    { platform: "linux" },
    { arch: "ia32" },
    { currentCommit: undefined },
    { currentCommit: "abc" },
    { runtimeExecutable: null },
    { userDataDirectory: undefined },
  ]) {
    const { instance } = controller(overrides);
    assert.deepEqual(instance.getState(), { status: "disabled" });
    assert.deepEqual(await instance.checkOnce(), { status: "disabled" });
  }
});

test("a check announces main only when it differs from the installed build", async () => {
  const current = controller({}, { fetchLatestCommit: async () => INSTALLED });
  assert.deepEqual(await current.instance.checkOnce(), { status: "up-to-date" });

  const dirty = controller({ currentSourceState: "dirty" }, { fetchLatestCommit: async () => INSTALLED });
  assert.deepEqual(await dirty.instance.checkOnce(), {
    status: "available", version: "5.0.8+1111111", automatic: false, blocked: "local-build",
  });

  const newer = controller();
  assert.deepEqual(await newer.instance.checkOnce(), { status: "available", version: "5.0.8+2222222", automatic: true });
  assert.deepEqual(newer.published.map(state => state.status), ["checking", "available"]);
});

test("a failed check reports the error but keeps an update that was already found", async () => {
  let fail = false;
  const { instance } = controller({}, {
    fetchLatestCommit: async () => {
      if (fail) throw new Error("offline");
      return MAIN;
    },
  });
  assert.equal((await instance.checkOnce()).status, "available");
  fail = true;
  assert.deepEqual(await instance.checkOnce(), { status: "available", version: "5.0.8+2222222", automatic: true });

  const fresh = controller({}, { fetchLatestCommit: async () => { throw new Error("offline"); } });
  assert.deepEqual(await fresh.instance.checkOnce(), { status: "error", message: "offline" });
  const invalid = controller({}, { fetchLatestCommit: async () => "main" });
  assert.equal((await invalid.instance.checkOnce()).status, "error");
});

test("an update builds the announced commit, passes all checks, and stages without replacing anything", async () => {
  const { instance, calls } = controller();
  await instance.checkOnce();
  const prepared = await instance.beginInstall();
  assert.equal(prepared.commit, MAIN);
  assert.equal(prepared.version, "5.0.8+2222222");
  assert.deepEqual(instance.getState(), {
    status: "installing", version: "5.0.8+2222222", automatic: false, waitingForIdle: true,
  });
  assert.deepEqual(calls.map(call => call.slice(0, 3)), [
    ["lock", calls[0][1]],
    ["checkout", MAIN, calls[1][2]],
    ["run", "bun", "install --frozen-lockfile"],
    ["run", "bun", "install --frozen-lockfile"],
    ["run", "bun", "run verify"],
    ["run", "bun", "run app:package"],
    ["unlock", calls[0][1]],
  ]);
  assert.ok(calls[1][2].startsWith("/runtime/bun-root/runtime"));
  const job = JSON.parse(fs.readFileSync(prepared.jobPath, "utf8"));
  assert.equal(job.version, 1);
  assert.equal(job.parentPid, process.pid);
  assert.equal(job.target, "/Applications/Codex Web GPT.app");
  assert.equal(job.executableName, "Codex Web GPT");
  assert.equal(path.basename(job.source), "Codex Web GPT.app");
  assert.equal(job.commit, MAIN);
  assert.equal(job.previousCommit, INSTALLED);
  assert.equal(job.displayVersion, "5.0.8+2222222");
  assert.equal(job.rollbackKeep, 2);
  assert.ok(job.rollbackRoot.endsWith("rollback.noindex"));
  assert.ok(job.healthPath.endsWith("source-update-health.json"));
  assert.ok(job.statePath.endsWith("source-update-state.json"));
  assert.ok(fs.existsSync(prepared.workerPath) && path.basename(prepared.workerPath) === "source-update-worker.cjs");
  assert.ok(!calls.some(call => call[0] === "worker"), "nothing is replaced before the caller launches the install");

  const launch = await instance.launchInstall(prepared);
  assert.equal(launch.child.pid, 4242);
  instance.abortLaunch(launch);
  instance.cancelInstall(prepared);
  assert.equal(fs.existsSync(prepared.tempRoot), false);
  assert.deepEqual(instance.getState(), { status: "available", version: "5.0.8+2222222", automatic: true });
});

test("the update reports its build step and what it waits for, publishing only changes", async () => {
  const { instance, published } = controller();
  await instance.checkOnce();
  const prepared = await instance.beginInstall();
  const steps = published.filter(state => state.status === "downloading" && state.step).map(state => `${state.step}/${state.steps}`);
  assert.deepEqual(steps, ["1/4", "2/4", "3/4", "4/4"]);
  const before = published.length;
  instance.noteInstallProgress({ activeTurns: 2, requested: false });
  instance.noteInstallProgress({ activeTurns: 2, requested: false });
  assert.equal(published.length, before + 1, "an unchanged note publishes nothing");
  instance.noteInstallProgress({ activeTurns: 0, requested: true });
  assert.deepEqual(instance.getState(), {
    status: "installing", version: "5.0.8+2222222", automatic: false, waitingForIdle: true, activeTurns: 0, requested: true,
  });
  instance.noteInstallProgress({ requested: false });
  assert.equal(instance.getState().requested, true, "a request is never withdrawn by a later note");
  instance.cancelInstall(prepared);
  const after = published.length;
  instance.noteInstallProgress({ activeTurns: 1, requested: true });
  assert.equal(published.length, after, "no note outside a pending install");
});

test("a failing test run keeps the installed build and leaves the update available", async () => {
  const { instance, calls, logs } = controller({}, {
    run: async (command, args) => {
      calls.push(["run", command, args.join(" ")]);
      if (args.join(" ") === "run verify") throw new Error("bun run verify exited with code 1");
    },
  });
  await instance.checkOnce();
  await assert.rejects(instance.beginInstall(), (error) => {
    assert.match(error.message, /Update to 5\.0\.8\+2222222 was not installed: run all tests \(bun run verify\) failed/);
    assert.ok(error.message.includes(path.join(logs, "source-update.log")));
    return true;
  });
  assert.ok(!calls.some(call => call[2] === "run app:package"), "a failed verification is never packaged");
  assert.equal(calls.filter(call => call[2] === "run verify").length, 2, "a failing suite is run a second time before the commit is rejected");
  assert.ok(!calls.some(call => call[0] === "worker"));
  assert.equal(calls.filter(call => call[0] !== "warn").at(-1)[0], "unlock");
  assert.deepEqual(instance.getState(), {
    status: "available", version: "5.0.8+2222222", automatic: false, blocked: "failed-before",
  });
  const recorded = readUpdateState(path.join(logs, "source-update-state.json"));
  assert.equal(recorded.failedCommits[MAIN].stage, "build");
  assert.match(recorded.failedCommits[MAIN].reason, /bun run verify/);
  assert.equal(instance.automaticCandidate(), null, "an unattended update never retries a failed commit");
});

test("a test that fails once under load is run again, and the update installs only if the suite then passes", async () => {
  let verifyRuns = 0;
  const { instance, calls, logs } = controller({}, {
    run: async (command, args) => {
      calls.push(["run", command, args.join(" ")]);
      if (args.join(" ") === "run verify" && ++verifyRuns === 1) throw new Error("bun run verify exited with code 1");
    },
  });
  await instance.checkOnce();
  const prepared = await instance.beginInstall();
  assert.equal(verifyRuns, 2);
  assert.ok(calls.some(call => call[0] === "warn" && call[1] === "launcher.update_step_retried"));
  assert.equal(instance.getState().waitingForIdle, true);
  assert.deepEqual(readUpdateState(path.join(logs, "source-update-state.json")).failedCommits, {});
  instance.cancelInstall(prepared);
});

test("a network failure during the build defers the update instead of rejecting the commit", async () => {
  const { instance, calls, logs } = controller({}, {
    run: async (command, args) => {
      calls.push(["run", command, args.join(" ")]);
      if (args.join(" ") === "install --frozen-lockfile") {
        throw Object.assign(new Error("bun install --frozen-lockfile exited with code 1"), {
          outputTail: ["error: GET https://registry.npmjs.org/electron - getaddrinfo ENOTFOUND registry.npmjs.org"],
        });
      }
    },
  });
  await instance.checkOnce();
  await assert.rejects(instance.beginInstall(), /network failed; it will be tried again/);
  assert.equal(calls.filter(call => call[2] === "install --frozen-lockfile").length, 1, "a network failure is not retried at once");
  assert.deepEqual(readUpdateState(path.join(logs, "source-update-state.json")).failedCommits, {});
  assert.deepEqual(instance.getState(), { status: "available", version: "5.0.8+2222222", automatic: true });
  assert.ok(instance.automaticCandidate(), "the next check installs it by itself");
  assert.ok(calls.some(call => call[0] === "warn" && call[1] === "launcher.update_deferred"));
  assert.equal(isTransientBuildFailure(new Error("git fetch failed: fatal: unable to access 'https://github.com/x/': Could not resolve host: github.com")), true);
  assert.equal(isTransientBuildFailure(Object.assign(new Error("bun run verify exited with code 1"), { outputTail: ["expect(received).toBe(expected)"] })), false);
});

test("update builds run in a private home, so no test can reach the user's Codex or bridge state", async () => {
  const seen = [];
  const { instance, logs } = controller({}, {
    prepareCheckout: async ({ env }) => seen.push(["checkout", env.HOME]),
    run: async (command, args, { env }) => seen.push([args.join(" "), env.HOME, env.CODEX_HOME, env.CODEX_CHATGPT_WEB_HOME, env.CODEX_SUPERPOWER_UPDATE_BUILD]),
  });
  await instance.checkOnce();
  const prepared = await instance.beginInstall();
  const buildHome = path.join(logs, "build-home");
  assert.equal(seen[0][0], "checkout");
  assert.equal(seen[0][1], process.env.HOME, "git keeps the real home for its proxy and credential settings");
  for (const step of seen.slice(1)) {
    assert.deepEqual(step.slice(1), [buildHome, path.join(buildHome, ".codex"), path.join(buildHome, ".codex-chatgpt-web"), "1"], step[0]);
  }
  assert.equal(seen.length, 5);
  instance.cancelInstall(prepared);

  const home = tempDir("cwg-real-home-");
  fs.writeFileSync(path.join(home, ".npmrc"), "registry=https://registry.example/\n");
  fs.mkdirSync(path.join(home, "Library", "Application Support", "go"), { recursive: true });
  fs.writeFileSync(path.join(home, "Library", "Application Support", "go", "env"), "GOPROXY=https://proxy.example\n");
  const privateHome = prepareBuildHome(home);
  assert.equal(privateHome, sourceBuildHome(home));
  assert.equal(privateHome, path.join(home, ".csp-build-home"));
  assert.equal(fs.readlinkSync(path.join(privateHome, ".npmrc")), path.join(home, ".npmrc"), "the company registry still applies");
  assert.equal(fs.existsSync(path.join(privateHome, ".bunfig.toml")), false);
  fs.writeFileSync(path.join(privateHome, "left-by-a-test"), "x");
  prepareBuildHome(home);
  assert.equal(fs.existsSync(path.join(privateHome, "left-by-a-test")), false, "every build starts from an empty home");
  const env = sourceBuildEnvironment({ baseEnv: { PATH: "/usr/bin", HTTPS_PROXY: "http://proxy:3128" }, home, buildHome: privateHome, pathValue: "/bin" });
  assert.deepEqual(env, {
    PATH: "/bin",
    HTTPS_PROXY: "http://proxy:3128",
    HOME: privateHome,
    CODEX_HOME: path.join(privateHome, ".codex"),
    CODEX_CHATGPT_WEB_HOME: path.join(privateHome, ".codex-chatgpt-web"),
    BUN_INSTALL_CACHE_DIR: path.join(home, ".bun", "install", "cache"),
    ELECTRON_CACHE: path.join(home, "Library", "Caches", "electron"),
    ELECTRON_BUILDER_CACHE: path.join(home, "Library", "Caches", "electron-builder"),
    CODEX_SUPERPOWER_CACHE: path.join(home, "Library", "Caches", "codex-superpower"),
    GOENV: path.join(home, "Library", "Application Support", "go", "env"),
    CODEX_SUPERPOWER_UPDATE_BUILD: "1",
  });
  assert.ok(Buffer.byteLength(path.join(sourceBuildHome("/Users/a-rather-long-user-name"), ".codex-chatgpt-web", "runtime", "turn-broker.sock")) <= 103, "a socket under the private home fits macOS's limit");
});

test("an update build runs every test but leaves the online dependency audit to CI", () => {
  const verify = fs.readFileSync(path.join(__dirname, "..", "..", "scripts", "verify.ts"), "utf8");
  assert.match(verify, /const updateBuild = process\.env\.CODEX_SUPERPOWER_UPDATE_BUILD === "1";/);
  assert.match(verify, /if \(updateBuild\) \{[\s\S]*?\} else \{\n\s*await run\(\["run", "audit"\]\);\n\s*await run\(\["run", "launcher:audit"\]\);/);
  assert.match(verify, /await run\(\["run", "test"\]\);/);
  const updater = fs.readFileSync(path.join(__dirname, "..", "electron", "source-update.cjs"), "utf8");
  assert.match(updater, /CODEX_SUPERPOWER_UPDATE_BUILD: "1",/);
  assert.match(updater, /const env = sourceBuildEnvironment\(\{ buildHome: deps\.prepareBuildHome\(\), pathValue: buildPath \}\);/);
});

test("a package that is not the announced commit is rejected", async () => {
  const { instance } = controller({}, { readPackagedCommit: () => INSTALLED });
  await instance.checkOnce();
  await assert.rejects(instance.beginInstall(), /was built from 1{40}, not 2{40}/);
  assert.equal(instance.getState().status, "available");
});

test("updates refuse to start without an announced update or while one is running", async () => {
  const { instance } = controller();
  await assert.rejects(instance.beginInstall(), /No launcher update is available/);
  await instance.checkOnce();
  let release;
  const slow = controller({}, { prepareCheckout: () => new Promise(resolve => { release = resolve; }) });
  await slow.instance.checkOnce();
  const first = slow.instance.beginInstall();
  await assert.rejects(slow.instance.beginInstall(), /already being prepared/);
  assert.deepEqual(await slow.instance.checkOnce(), { status: "downloading", version: "5.0.8+2222222", automatic: false });
  release();
  slow.instance.cancelInstall(await first);
});

test("the build lock excludes a live owner and reclaims a dead one", () => {
  const root = tempDir("cwg-source-lock-");
  const lock = path.join(root, "source.lock");
  assert.equal(acquireLock(lock), lock);
  assert.throws(() => acquireLock(lock), /Another source update or install is running \(PID \d+\)/);
  releaseLock(lock);

  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "pid"), "999999999\n");
  assert.equal(acquireLock(lock), lock, "a lock owned by an exited process is reclaimed");
  releaseLock(lock);

  fs.mkdirSync(lock);
  assert.throws(() => acquireLock(lock), /Another source update or install is running/, "a fresh lock without a PID is held");
  assert.equal(acquireLock(lock, Date.now() + 120_000), lock, "an abandoned lock without a PID is reclaimed");
  releaseLock(lock);
  fs.rmSync(root, { recursive: true, force: true });
});

function gitIn(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("the managed checkout is cloned, pinned to the exact commit, and cleaned", async () => {
  const root = tempDir("cwg-source-git-");
  const origin = path.join(root, "origin");
  fs.mkdirSync(origin);
  gitIn(origin, "init", "--quiet", "--initial-branch=main");
  gitIn(origin, "config", "user.email", "test@example.com");
  gitIn(origin, "config", "user.name", "Test");
  fs.writeFileSync(path.join(origin, "file.txt"), "one\n");
  gitIn(origin, "add", "file.txt");
  gitIn(origin, "commit", "--quiet", "-m", "one");
  const first = gitIn(origin, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(origin, "file.txt"), "two\n");
  gitIn(origin, "commit", "--quiet", "-am", "two");
  const second = gitIn(origin, "rev-parse", "HEAD");

  const sourceRoot = path.join(root, "managed");
  const env = { ...process.env };
  await prepareCheckout({ sourceRoot, commit: first, env, cloneUrl: origin });
  assert.equal(gitIn(sourceRoot, "rev-parse", "HEAD"), first);
  assert.equal(fs.readFileSync(path.join(sourceRoot, "file.txt"), "utf8"), "one\n");

  fs.writeFileSync(path.join(sourceRoot, "file.txt"), "local edit\n");
  fs.writeFileSync(path.join(sourceRoot, "stray.txt"), "untracked\n");
  await prepareCheckout({ sourceRoot, commit: second, env, cloneUrl: origin });
  assert.equal(gitIn(sourceRoot, "rev-parse", "HEAD"), second);
  assert.equal(fs.readFileSync(path.join(sourceRoot, "file.txt"), "utf8"), "two\n");
  assert.equal(fs.existsSync(path.join(sourceRoot, "stray.txt")), false);

  await assert.rejects(prepareCheckout({ sourceRoot, commit: "f".repeat(40), env, cloneUrl: origin }), /git merge-base|git cat-file|fatal|not a valid/i);
  await assert.rejects(prepareCheckout({ sourceRoot, commit: second, env, cloneUrl: "https://example.com/other.git" }), /tracks .* not https:\/\/example\.com\/other\.git/);
  await assert.rejects(prepareCheckout({ sourceRoot, commit: "main", env, cloneUrl: origin }), /invalid commit/);

  // A clone made before the repository was renamed moves to the new address instead of failing.
  const renamed = path.join(root, "renamed-origin");
  fs.renameSync(origin, renamed);
  await prepareCheckout({ sourceRoot, commit: second, env, cloneUrl: renamed, legacyCloneUrls: [origin] });
  assert.equal(gitIn(sourceRoot, "remote", "get-url", "origin"), renamed);
  assert.equal(gitIn(sourceRoot, "rev-parse", "HEAD"), second);
  fs.rmSync(root, { recursive: true, force: true });
});

test("the old repository address is accepted only as a legacy origin of the managed clone", () => {
  assert.deepEqual(LEGACY_SOURCE_CLONE_URLS, ["https://github.com/trukhinyuri/codex-chatgpt-web.git"]);
  const installer = fs.readFileSync(path.join(__dirname, "..", "..", "scripts", "install-fork-macos.sh"), "utf8");
  assert.match(installer, /REPO_URL="https:\/\/github\.com\/trukhinyuri\/codex-superpower\.git"/);
  assert.match(installer, /\*trukhinyuri\/codex-chatgpt-web\|\*trukhinyuri\/codex-chatgpt-web\.git\) git -C "\$SRC" remote set-url origin "\$REPO_URL"/);
});

function loadQuitWhenIdle(context) {
  const vm = require("node:vm");
  const main = fs.readFileSync(path.join(__dirname, "..", "electron", "main.cjs"), "utf8");
  const start = main.indexOf("async function quitWhenIdleForUpdate(");
  const end = main.indexOf("\nasync function requestQuit(", start);
  assert.ok(start >= 0 && end > start, "main.cjs defines the idle-gated update quit");
  vm.runInNewContext(`${main.slice(start, end)}\nglobalThis.quitWhenIdleForUpdate = quitWhenIdleForUpdate;`, context);
  return context.quitWhenIdleForUpdate;
}

test("an update replaces the app only after Codex stays idle, and never cancels a turn to do it", async () => {
  const activity = [
    { active_http_turns: 1, active_browser_turns: 1 },
    { active_http_turns: 0, active_browser_turns: 0 },
    { active_http_turns: 0, active_browser_turns: 0 },
    { active_http_turns: 0, active_browser_turns: 0 },
    { active_http_turns: 0, active_browser_turns: 0 },
  ];
  const events = [];
  let launches = 0;
  const quitResults = [{ ok: false, message: "daemon has 1 active browser turn(s)" }, { ok: true }];
  const context = {
    UPDATE_IDLE_QUIET_MS: 0,
    UPDATE_IDLE_POLL_MS: 1,
    Date,
    setTimeout,
    updateIdleWait: null,
    updateInstallRequested: false,
    turnOutcomes: createTurnOutcomeLog(),
    updateQuietWindow,
    activeTurnCount: health => (health?.active_http_turns ?? 0) + (health?.active_browser_turns ?? 0),
    runtimeActivity: async () => {
      const next = activity.shift() ?? { active_http_turns: 0, active_browser_turns: 0 };
      events.push(`activity:${next.active_http_turns + next.active_browser_turns}`);
      return next;
    },
    updateController: {
      launchInstall: prepared => { events.push(`launch:${prepared.version}`); launches += 1; return { id: launches }; },
      abortLaunch: launch => events.push(`abort:${launch.id}`),
      noteInstallProgress: () => {},
    },
    requestQuit: async (options) => {
      events.push(`quit:${JSON.stringify(options)}`);
      return quitResults.shift();
    },
  };
  const quitWhenIdleForUpdate = loadQuitWhenIdle(context);
  await quitWhenIdleForUpdate({ version: "5.0.8+2222222" }, { info: event => { if (event === "launcher.update_waiting_for_idle") events.push("wait"); } });
  assert.deepEqual(events.filter(event => !event.startsWith("activity")), [
    "launch:5.0.8+2222222",
    'quit:{"preserveActiveTurns":true,"quiet":true}',
    "abort:1",
    "wait",
    "launch:5.0.8+2222222",
    'quit:{"preserveActiveTurns":true,"quiet":true}',
  ]);
  assert.equal(events[0], "activity:2", "the first poll saw active turns and did not launch the install");
  assert.equal(events[1], "activity:0");
});

test("a click on a waiting update installs it 30 s after Codex's tasks, or now if the user chooses to stop them", async () => {
  const running = { active_http_turns: 1, active_browser_turns: 1 };
  const idle = { active_http_turns: 0, active_browser_turns: 0 };
  const makeContext = ({ activity, answer }) => {
    const events = [];
    const context = {
      UPDATE_IDLE_QUIET_MS: 30_000,
      UPDATE_IDLE_POLL_MS: 1,
      Date,
      setTimeout,
      updateIdleWait: null,
      updateInstallRequested: false,
      turnOutcomes: createTurnOutcomeLog(),
      updateQuietWindow,
      activeTurnCount: health => (health?.active_http_turns ?? 0) + (health?.active_browser_turns ?? 0),
      runtimeActivity: async () => activity(),
      launcherLanguage: () => "en",
      nativeCopyFor: () => ({
        updateRunningTitle: "Codex is running {count} task(s)",
        updateRunningDetail: "detail",
        updateWhenIdle: "Install when they finish",
        updateNow: "Install now and stop them",
      }),
      showNativeDialog: async options => { events.push(`dialog:${options.message}:${options.buttons.join("|")}:${options.defaultId}`); return { response: answer }; },
      updateController: {
        launchInstall: () => { events.push("launch"); return {}; },
        abortLaunch: () => events.push("abort"),
        noteInstallProgress: note => events.push(`note:${JSON.stringify(note)}`),
      },
      requestQuit: async options => { events.push(`quit:${JSON.stringify(options)}`); return { ok: true }; },
    };
    const vm = require("node:vm");
    const main = fs.readFileSync(path.join(__dirname, "..", "electron", "main.cjs"), "utf8");
    const start = main.indexOf("async function quitWhenIdleForUpdate(");
    const end = main.indexOf("\n/**\n * Unattended updates:", start);
    assert.ok(start >= 0 && end > start);
    vm.runInNewContext(`${main.slice(start, end)}\nglobalThis.quitWhenIdleForUpdate = quitWhenIdleForUpdate;\nglobalThis.installPendingUpdateSooner = installPendingUpdateSooner;\nglobalThis.waitState = () => updateIdleWait;`, context);
    return { context, events };
  };

  // Tasks keep running: the unattended ten-minute wait never ends until the user clicks "install now".
  {
    const { context, events } = makeContext({ activity: () => running, answer: 1 });
    const waiting = context.quitWhenIdleForUpdate({ version: "v" }, { info() {} }, 10 * 60_000);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(context.waitState().quietMs, 10 * 60_000);
    assert.equal(await context.installPendingUpdateSooner(), true);
    await waiting;
    assert.ok(events.includes("dialog:Codex is running 2 task(s):Install when they finish|Install now and stop them:0"), "the dialog keeps the tasks by default");
    assert.deepEqual(events.filter(event => event === "launch" || event.startsWith("quit:")), ["launch", 'quit:{"preserveActiveTurns":false,"quiet":true}']);
    assert.ok(events.some(event => event === 'note:{"activeTurns":2,"requested":true}'), "the button learns what the update waits for");
  }

  // The user keeps the tasks: the wait shortens to 30 s and the update never stops them.
  {
    let polls = 0;
    const { context, events } = makeContext({ activity: () => (++polls < 4 ? running : idle), answer: 0 });
    context.UPDATE_IDLE_QUIET_MS = 0;
    const waiting = context.quitWhenIdleForUpdate({ version: "v" }, { info() {} }, 10 * 60_000);
    await new Promise(resolve => setTimeout(resolve, 1));
    await context.installPendingUpdateSooner();
    await waiting;
    assert.deepEqual(events.filter(event => event.startsWith("quit:")), ['quit:{"preserveActiveTurns":true,"quiet":true}']);
    assert.ok(polls >= 4, "the install waited for the tasks to finish");
  }

  // A click while the update still builds: the wait that follows starts with the short window.
  {
    const { context } = makeContext({ activity: () => idle, answer: 0 });
    assert.equal(await context.installPendingUpdateSooner(), true);
    assert.equal(context.updateInstallRequested, true);
  }
});

test("a build whose turns only fail installs its fix after one quiet minute, and a busy healthy one still waits", () => {
  let clock = 1_000_000_000;
  const outcomes = createTurnOutcomeLog({ now: () => clock });
  const window = () => updateQuietWindow({ baseQuietMs: 10 * 60_000, outcomes, waitingSince: 1_000_000_000, now: clock });
  assert.deepEqual(window(), { quietMs: 10 * 60_000, reason: "idle" }, "no evidence: the long unattended window");
  outcomes.record("failed");
  outcomes.record("aborted");
  assert.equal(window().reason, "idle", "two failures are not yet a failing build");
  outcomes.record("failed");
  assert.deepEqual(window(), { quietMs: SHORT_QUIET_MS, reason: "failing" });
  outcomes.record("completed");
  assert.equal(window().reason, "idle", "one completed turn means there is work to protect");
  clock += 16 * 60_000;
  outcomes.record("failed");
  assert.equal(window().reason, "idle", "failures older than fifteen minutes no longer count");
  clock = 1_000_000_000 + LONG_WAIT_MS;
  assert.deepEqual(window(), { quietMs: SHORT_QUIET_MS, reason: "long-wait" }, "after six hours a one-minute lull is enough");
  assert.equal(updateQuietWindow({ baseQuietMs: 30_000, outcomes, waitingSince: clock, now: clock + LONG_WAIT_MS }).quietMs, 30_000, "a click's shorter window is never lengthened");
  outcomes.record("unknown");
  assert.equal(outcomes.since(0).length, 5, "only known outcomes are recorded");
});

test("while turns keep failing, the waiting update installs in the first quiet minute instead of never", async () => {
  const events = [];
  const failing = createTurnOutcomeLog();
  for (const status of ["failed", "failed", "aborted"]) failing.record(status);
  const context = {
    UPDATE_IDLE_QUIET_MS: 30_000,
    UPDATE_IDLE_POLL_MS: 1,
    Date,
    setTimeout,
    updateIdleWait: null,
    updateInstallRequested: false,
    turnOutcomes: failing,
    // The real policy with its one-minute floor replaced by zero so the test runs at once.
    updateQuietWindow: options => {
      const decided = updateQuietWindow(options);
      return decided.reason === "failing" ? { ...decided, quietMs: 0 } : decided;
    },
    activeTurnCount: health => (health?.active_http_turns ?? 0) + (health?.active_browser_turns ?? 0),
    runtimeActivity: async () => ({ active_http_turns: 0, active_browser_turns: 0 }),
    updateController: {
      launchInstall: () => { events.push("launch"); return {}; },
      abortLaunch: () => events.push("abort"),
      noteInstallProgress: () => {},
    },
    requestQuit: async options => { events.push(`quit:${JSON.stringify(options)}`); return { ok: true }; },
  };
  const quitWhenIdleForUpdate = loadQuitWhenIdle(context);
  await quitWhenIdleForUpdate({ version: "v" }, { info: (event, detail) => events.push(`${event}:${detail.reason}`) }, 10 * 60_000);
  assert.deepEqual(events, ["launcher.update_quiet_window:failing", "launch", 'quit:{"preserveActiveTurns":true,"quiet":true}'], "the unattended ten minutes do not apply to a failing build, and nothing is cancelled");
  const main = fs.readFileSync(path.join(__dirname, "..", "electron", "main.cjs"), "utf8");
  assert.match(main, /onTurnEnded: status => turnOutcomes\.record\(status\),/);
});

test("the update quit drains without cancelling while an ordinary quit keeps cancelling", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "electron", "main.cjs"), "utf8");
  assert.match(main, /if \(preserveActiveTurns\) await runtimeSupervisor\?\.shutdown\(\);\n\s*else await runtimeSupervisor\?\.shutdown\(\{ cancelActiveTurns: true, force: true \}\);/);
  assert.match(main, /const prepared = await updateController\.beginInstall\(\);[\s\S]*?await quitWhenIdleForUpdate\(prepared, logger\);/);
  assert.match(main, /createSourceUpdateController\(\{[\s\S]*?currentCommit: LAUNCHER_MANIFEST\.sourceCommit,/);
  assert.doesNotMatch(main, /createUpdateController\(/, "the fork never offers upstream release packages");
});

test("CI and history decide whether an update may install by itself", () => {
  const mac = (status, conclusion) => ({ name: "verify (macos-15)", status, conclusion });
  assert.equal(classifyCheckRuns({ check_runs: [] }), "none");
  assert.equal(classifyCheckRuns({ check_runs: [mac("in_progress")] }), "pending");
  assert.equal(classifyCheckRuns({ check_runs: [mac("completed", "success"), mac("completed", "skipped")] }), "success");
  assert.equal(classifyCheckRuns({ check_runs: [mac("completed", "success"), mac("completed", "failure")] }), "failure");
  assert.equal(classifyCheckRuns({ check_runs: [mac("completed", "cancelled")] }), "failure");
  assert.equal(classifyCheckRuns({ check_runs: [
    mac("completed", "success"),
    { name: "verify (windows-latest)", status: "completed", conclusion: "failure" },
    { name: "verify (ubuntu-latest)", status: "in_progress" },
  ] }), "success", "only the macOS jobs gate macOS updates");
  assert.equal(classifyCheckRuns({ check_runs: [{ name: "actionlint", status: "completed", conclusion: "failure" }] }), "none");
  assert.equal(classifyComparison({ status: "ahead" }), "ahead");
  assert.equal(classifyComparison({ message: "Not Found" }), "unknown");

  const clean = { sourceState: "clean", relation: "ahead", ci: "success", failedBefore: false };
  assert.equal(automaticUpdateBlocker(clean), null);
  assert.equal(automaticUpdateBlocker({ ...clean, ci: "none" }), null, "a repository without CI relies on the local test run");
  assert.equal(automaticUpdateBlocker({ ...clean, ci: "pending" }), "ci-pending");
  assert.equal(automaticUpdateBlocker({ ...clean, ci: "failure" }), "ci-failure");
  assert.equal(automaticUpdateBlocker({ ...clean, ci: "unknown" }), "ci-unknown");
  assert.equal(automaticUpdateBlocker({ ...clean, relation: "diverged" }), "history-diverged");
  assert.equal(automaticUpdateBlocker({ ...clean, relation: "unknown" }), "history-unknown");
  assert.equal(automaticUpdateBlocker({ ...clean, failedBefore: true }), "failed-before");
  assert.equal(automaticUpdateBlocker({ ...clean, sourceState: "dirty" }), "local-build");
});

test("a build newer than main is never downgraded, and doubtful updates wait for a click", async () => {
  const newer = controller({}, { fetchComparison: async () => ({ status: "behind" }) });
  assert.deepEqual(await newer.instance.checkOnce(), { status: "up-to-date" });

  for (const [dependencies, blocked] of [
    [{ fetchComparison: async () => ({ status: "diverged" }) }, "history-diverged"],
    [{ fetchComparison: async () => { throw new Error("HTTP 403"); } }, "history-unknown"],
    [{ fetchCheckRuns: async () => ({ check_runs: [{ name: "verify (macos-15)", status: "queued" }] }) }, "ci-pending"],
    [{ fetchCheckRuns: async () => ({ check_runs: [{ name: "verify (macos-15)", status: "completed", conclusion: "failure" }] }) }, "ci-failure"],
    [{ fetchCheckRuns: async () => { throw new Error("HTTP 403"); } }, "ci-unknown"],
  ]) {
    const { instance } = controller({}, dependencies);
    assert.deepEqual(await instance.checkOnce(), { status: "available", version: "5.0.8+2222222", automatic: false, blocked });
    assert.equal(instance.automaticCandidate(), null);
    await assert.rejects(instance.beginInstall({ automatic: true }), /needs a manual install/);
  }

  const green = controller({}, { fetchCheckRuns: async () => ({ check_runs: [{ name: "verify (macos-15)", status: "completed", conclusion: "success" }] }) });
  await green.instance.checkOnce();
  assert.equal(green.instance.automaticCandidate().commit, MAIN);
});

test("a commit that failed here before is offered only for a manual install", async () => {
  const { instance, logs } = controller();
  recordFailedCommit(path.join(logs, "source-update-state.json"), MAIN, { stage: "startup", reason: "no healthy start" });
  assert.deepEqual(await instance.checkOnce(), {
    status: "available", version: "5.0.8+2222222", automatic: false, blocked: "failed-before",
  });
  const prepared = await instance.beginInstall();
  assert.equal(prepared.commit, MAIN, "the user can still install it by hand");
  instance.cancelInstall(prepared);
});

test("the failed-commit memory is bounded and keeps the newest entries", () => {
  const file = path.join(tempDir("cwg-source-state-"), "source-update-state.json");
  for (let index = 0; index < 25; index += 1) {
    recordFailedCommit(file, index.toString(16).padStart(40, "0"), {
      stage: "build", reason: "x".repeat(900), at: new Date(Date.UTC(2026, 8, 18, 0, index)).toISOString(),
    });
  }
  const state = readUpdateState(file);
  assert.equal(Object.keys(state.failedCommits).length, 20);
  assert.ok(state.failedCommits[(24).toString(16).padStart(40, "0")]);
  assert.equal(state.failedCommits["0".repeat(40)], undefined);
  assert.equal(state.lastResult.reason.length, 500);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readUpdateState(path.join(path.dirname(file), "missing.json")), { version: 1, failedCommits: {}, lastResult: null });
});

test("a rollback from the previous update is reported when the launcher starts", () => {
  const logs = tempDir("cwg-source-rollback-note-");
  fs.writeFileSync(path.join(logs, "source-update-state.json"), JSON.stringify({
    version: 1, failedCommits: {}, lastResult: { commit: MAIN, result: "rolled-back", stage: "startup", at: "2026-09-18T00:00:00.000Z" },
  }));
  const { calls } = controller({ logsDirectory: logs, userDataDirectory: logs });
  assert.deepEqual(calls.find(call => call[0] === "warn").slice(0, 2), ["warn", "launcher.update_rolled_back"]);
});

test("startup health is a small private record without free text from the session", () => {
  const file = path.join(tempDir("cwg-source-health-"), "nested", "source-update-health.json");
  assert.equal(writeStartupHealth(file, { commit: MAIN, status: "healthy", reason: "runtime-ready", pid: 7, at: new Date(0) }), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    version: 1, commit: MAIN, pid: 7, status: "healthy", reason: "runtime-ready", at: "1970-01-01T00:00:00.000Z",
  });
  assert.equal(applicationBundle("/Applications/Codex Web GPT.app/Contents/MacOS/Codex Web GPT"), "/Applications/Codex Web GPT.app");
  assert.throws(() => applicationBundle("/usr/local/bin/codex-web-gpt"), /application bundle/);
});

test("the launcher reports its start, installs unattended updates only after a long idle period, and honours the setting", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "electron", "main.cjs"), "utf8");
  assert.match(main, /app\.quit\(\);\n\s*return;\n\s*\}\n\s*reportLauncherStartup\("starting"\);/);
  assert.match(main, /const runtimeHealthy = runtime\.status === "ready" \|\| runtime\.status === "not-configured";/);
  assert.match(main, /reportLauncherStartup\(\n\s*runtimeHealthy && proxyHealthy \? "healthy" : "unhealthy",/);
  // Without a managed proxy nothing runs for it, so a start never fails on its account.
  assert.match(main, /if \(!fs\.existsSync\(path\.join\(CORE_HOME, "cliproxyapi", "service\.json"\)\)\) return \{ status: "off" \};/);
  // A managed CLIProxyAPI is brought to the bundled binary before the bridge starts taking turns.
  assert.ok(main.indexOf("const cliproxy = await syncCliProxyService(logger);") < main.indexOf("const runtime = await runtimeSupervisor.startIfConfigured();"));
  assert.match(main, /reportLauncherStartup\("unhealthy", "runtime-start-error"\);/);
  assert.match(main, /reportLauncherStartup\("unhealthy", "launcher-start-error"\);/);
  assert.match(main, /const AUTOMATIC_UPDATE_IDLE_QUIET_MS = 10 \* 60_000;/);
  assert.match(main, /stateStore\.read\(\)\.automaticUpdates !== true \|\| !updateController\.automaticCandidate\(\)/);
  assert.match(main, /beginInstall\(\{ automatic: true \}\);[\s\S]*?quitWhenIdleForUpdate\(prepared, logger, AUTOMATIC_UPDATE_IDLE_QUIET_MS\)/);
  assert.match(main, /key === "automaticUpdates"/);
  assert.match(main, /userDataDirectory: app\.getPath\("userData"\),/);
  const state = fs.readFileSync(path.join(__dirname, "..", "electron", "state.cjs"), "utf8");
  assert.match(state, /automaticUpdates: true,/);
});

test("a verified build survives a launcher restart and is not built again", async () => {
  const logs = tempDir("cwg-source-restart-");
  const first = controller({ logsDirectory: logs, userDataDirectory: logs }, { stagingParent: logs });
  await first.instance.checkOnce();
  const prepared = await first.instance.beginInstall();
  assert.ok(first.calls.some(call => call[0] === "run"), "the first launcher builds and tests");
  assert.equal(path.basename(prepared.tempRoot), `codex-web-gpt-update-${MAIN.slice(0, 12)}`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(prepared.tempRoot, "verified.json"), "utf8")).commit, MAIN);

  // The launcher quits before an idle window arrives; the next one finds the same verified build.
  const lines = [];
  const second = controller({ logsDirectory: logs, userDataDirectory: logs }, { stagingParent: logs, appendLog: (_file, line) => lines.push(line) });
  await second.instance.checkOnce();
  const again = await second.instance.beginInstall();
  assert.equal(again.tempRoot, prepared.tempRoot);
  assert.ok(!second.calls.some(call => call[0] === "run" || call[0] === "checkout" || call[0] === "lock"), "nothing is built or locked again");
  assert.ok(lines.some(line => line.startsWith(`reusing the verified build of ${MAIN}`)));
  assert.equal(JSON.parse(fs.readFileSync(again.jobPath, "utf8")).parentPid, process.pid);
  second.instance.cancelInstall(again);
  assert.equal(fs.existsSync(prepared.tempRoot), false);
});

test("a start removes only this app's stale staged builds", () => {
  const logs = tempDir("cwg-source-clean-");
  const bundle = "/Applications/Codex Web GPT.app";
  const stage = (name, job, verified) => {
    const dir = path.join(logs, name);
    fs.mkdirSync(path.join(dir, "stage"), { recursive: true });
    if (job) fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify(job));
    if (verified) fs.writeFileSync(path.join(dir, "verified.json"), JSON.stringify(verified));
    return dir;
  };
  const legacy = stage("codex-web-gpt-update-Ab3xYz", { target: bundle, commit: MAIN }, null);
  const installed = stage(`codex-web-gpt-update-${INSTALLED.slice(0, 12)}`, { target: bundle, commit: INSTALLED }, { commit: INSTALLED, bundle });
  const unverified = stage("codex-web-gpt-update-333333333333", { target: bundle, commit: "3".repeat(40) }, null);
  const pending = stage(`codex-web-gpt-update-${MAIN.slice(0, 12)}`, { target: bundle, commit: MAIN }, { commit: MAIN, bundle });
  const otherApp = stage("codex-web-gpt-update-Qw9zzz", { target: "/Applications/Other.app", commit: MAIN }, null);
  controller({ logsDirectory: logs, userDataDirectory: logs }, { stagingParent: logs });
  assert.equal(fs.existsSync(legacy), false);
  assert.equal(fs.existsSync(installed), false);
  assert.equal(fs.existsSync(unverified), false);
  assert.equal(fs.existsSync(pending), true, "a verified build for a newer commit waits for the next idle window");
  assert.equal(fs.existsSync(otherApp), true, "folders of another app are never touched");
});

test("the launcher quits for an update only after the worker confirms it can install", async () => {
  let clock = 0;
  const silent = controller({}, {
    now: () => clock,
    sleep: async () => { clock += 1_000; },
    spawnWorker: () => ({ pid: 5151, exitCode: null, unref() {}, kill() { silent.calls.push(["killed"]); } }),
  });
  await silent.instance.checkOnce();
  const prepared = await silent.instance.beginInstall();
  await assert.rejects(silent.instance.launchInstall(prepared), /did not confirm/);
  assert.ok(silent.calls.some(call => call[0] === "killed"), "a silent worker is stopped");

  const crashed = controller({}, { spawnWorker: () => ({ pid: 5152, exitCode: 1, unref() {}, kill() {} }) });
  await crashed.instance.checkOnce();
  const crashedPrepared = await crashed.instance.beginInstall();
  await assert.rejects(crashed.instance.launchInstall(crashedPrepared), /did not confirm/);

  const incomplete = controller();
  await incomplete.instance.checkOnce();
  const gone = await incomplete.instance.beginInstall();
  fs.rmSync(gone.workerPath);
  await assert.rejects(incomplete.instance.launchInstall(gone), /staged update is incomplete: source-update-worker\.cjs is missing/);
  assert.ok(!incomplete.calls.some(call => call[0] === "worker"), "nothing is spawned for an incomplete stage");
  for (const [instance, staged] of [[silent.instance, prepared], [crashed.instance, crashedPrepared], [incomplete.instance, gone]]) instance.cancelInstall(staged);
});

test("a stage that belongs to a running launcher is never cleaned, even from another process", () => {
  const logs = tempDir("cwg-source-live-");
  const bundle = "/Applications/Codex Web GPT.app";
  const dir = path.join(logs, "codex-web-gpt-update-Liv3aa");
  fs.mkdirSync(path.join(dir, "stage"), { recursive: true });
  // process.ppid is alive and is not this process: exactly the live launcher a test runs beside.
  fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify({ target: bundle, commit: MAIN, parentPid: process.ppid }));
  controller({ logsDirectory: logs, userDataDirectory: logs }, { stagingParent: logs });
  assert.equal(fs.existsSync(dir), true);
  fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify({ target: bundle, commit: MAIN, parentPid: 999_999 }));
  controller({ logsDirectory: logs, userDataDirectory: logs }, { stagingParent: logs });
  assert.equal(fs.existsSync(dir), false, "a stage whose launcher is gone is cleaned");
});

test("every updater test keeps staged builds out of the real temporary folder", () => {
  for (const file of ["source-update.test.cjs", "problem-report.test.cjs"]) {
    const source = fs.readFileSync(path.join(__dirname, file), "utf8");
    const constructions = source.split("createSourceUpdateController(").length - 1;
    const isolated = (source.match(/stagingParent: logs/g) || []).length;
    assert.ok(isolated >= Math.min(constructions, 1), `${file} passes stagingParent to its controllers`);
    // A test that builds must not empty the private build home of a real update running on this Mac.
    if (source.includes(".beginInstall(")) assert.match(source, /prepareBuildHome: \(\) =>/, `${file} passes prepareBuildHome to controllers that build`);
  }
});

test("a quit asks first while Codex has turns in flight; signals and idle quits do not", async () => {
  const vm = require("node:vm");
  const main = fs.readFileSync(path.join(__dirname, "..", "electron", "main.cjs"), "utf8");
  const start = main.indexOf("async function quitAfterConfirmation(");
  const end = main.indexOf("\nasync function requestQuit(", start);
  assert.ok(start >= 0 && end > start);
  const run = async ({ active, answer }) => {
    const events = [];
    const context = {
      exitCommitted: false,
      shutdownInProgress: false,
      mainWindow: null,
      String,
      runtimeActivity: async () => ({ active_http_turns: active, active_browser_turns: 0 }),
      activeTurnCount: health => (health?.active_http_turns ?? 0) + (health?.active_browser_turns ?? 0),
      showNativeDialog: async options => context.dialog.showMessageBox(options),
      nativeCopyFor: () => ({ quitRunningTitle: "Codex is running {count} task(s)", quitRunningDetail: "d", quitKeepRunning: "Keep", quitAnyway: "Quit" }),
      launcherLanguage: () => "en",
      dialog: { showMessageBox: async (options) => { events.push(["dialog", options.message, options.defaultId, options.cancelId]); return { response: answer }; } },
      requestQuit: async () => { events.push(["quit"]); },
    };
    vm.runInNewContext(`${main.slice(start, end)}\nglobalThis.quitAfterConfirmation = quitAfterConfirmation;`, context);
    await context.quitAfterConfirmation();
    return events;
  };
  assert.deepEqual(await run({ active: 0, answer: 0 }), [["quit"]], "nothing running: quit at once");
  assert.deepEqual(await run({ active: 2, answer: 0 }), [["dialog", "Codex is running 2 task(s)", 0, 0]], "the default keeps the launcher running");
  assert.deepEqual(await run({ active: 2, answer: 1 }), [["dialog", "Codex is running 2 task(s)", 0, 0], ["quit"]]);
  assert.match(main, /app\.on\("before-quit", \(event\) => \{\n\s*if \(exitCommitted\) return;\n\s*event\.preventDefault\(\);\n\s*void quitAfterConfirmation\(\);/);
  assert.match(main, /process\.once\("SIGTERM", \(\) => \{ void requestQuit\(\); \}\);/);
});
