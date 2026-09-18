const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  SOURCE_BRANCH,
  SOURCE_CLONE_URL,
  SOURCE_COMMIT_API_URL,
  acquireLock,
  createSourceUpdateController,
  defaultSourceRoot,
  lowPriorityCommand,
  prepareCheckout,
  releaseLock,
  sourceBuildPath,
  sourceBuildSteps,
  sourceUpdateVersion,
} = require("../electron/source-update.cjs");

const INSTALLED = "1".repeat(40);
const MAIN = "2".repeat(40);

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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
    sourceRoot: path.join(logs, "source"),
    publish: state => published.push(state),
    ...overrides,
    dependencies: {
      fetchLatestCommit: async () => MAIN,
      readLoginShellPath: async () => "/opt/homebrew/bin:/usr/bin",
      acquireLock: lockPath => { calls.push(["lock", lockPath]); return lockPath; },
      releaseLock: lockPath => calls.push(["unlock", lockPath]),
      appendLog: () => {},
      prepareCheckout: async ({ commit, env }) => calls.push(["checkout", commit, env.PATH]),
      run: async (command, args, { cwd }) => calls.push(["run", command, args.join(" "), path.basename(cwd)]),
      findPackage: () => path.join(logs, "codex-web-gpt-5.0.8-mac-arm64.zip"),
      extractMac: (_archive, destination) => {
        fs.mkdirSync(path.join(destination, "Codex Web GPT.app", "Contents", "MacOS"), { recursive: true });
        fs.writeFileSync(path.join(destination, "Codex Web GPT.app", "Contents", "MacOS", "Codex Web GPT"), "");
      },
      readPackagedCommit: () => MAIN,
      spawnWorker: (_runtime, workerPath, jobPath) => {
        calls.push(["worker", path.basename(workerPath), path.basename(jobPath)]);
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
  assert.equal(SOURCE_CLONE_URL, "https://github.com/trukhinyuri/codex-chatgpt-web.git");
  assert.equal(SOURCE_COMMIT_API_URL, "https://api.github.com/repos/trukhinyuri/codex-chatgpt-web/commits/main");
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
  assert.deepEqual(await dirty.instance.checkOnce(), { status: "available", version: "5.0.8+1111111" });

  const newer = controller();
  assert.deepEqual(await newer.instance.checkOnce(), { status: "available", version: "5.0.8+2222222" });
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
  assert.deepEqual(await instance.checkOnce(), { status: "available", version: "5.0.8+2222222" });

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
  assert.deepEqual(instance.getState(), { status: "installing", version: "5.0.8+2222222" });
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
  assert.equal(job.platform, "darwin");
  assert.equal(job.target, "/Applications/Codex Web GPT.app");
  assert.equal(job.version, "5.0.8+2222222");
  assert.ok(!calls.some(call => call[0] === "worker"), "nothing is replaced before the caller launches the install");

  const launch = instance.launchInstall(prepared);
  assert.equal(launch.child.pid, 4242);
  instance.abortLaunch(launch);
  instance.cancelInstall(prepared);
  assert.equal(fs.existsSync(prepared.tempRoot), false);
  assert.deepEqual(instance.getState(), { status: "available", version: "5.0.8+2222222" });
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
  assert.ok(!calls.some(call => call[0] === "worker"));
  assert.equal(calls.at(-1)[0], "unlock");
  assert.deepEqual(instance.getState(), { status: "available", version: "5.0.8+2222222" });
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
  assert.deepEqual(await slow.instance.checkOnce(), { status: "downloading", version: "5.0.8+2222222" });
  release();
  await first;
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
  fs.rmSync(root, { recursive: true, force: true });
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
    runtimeActivity: async () => {
      const next = activity.shift() ?? { active_http_turns: 0, active_browser_turns: 0 };
      events.push(`activity:${next.active_http_turns + next.active_browser_turns}`);
      return next;
    },
    updateController: {
      launchInstall: prepared => { events.push(`launch:${prepared.version}`); launches += 1; return { id: launches }; },
      abortLaunch: launch => events.push(`abort:${launch.id}`),
    },
    requestQuit: async (options) => {
      events.push(`quit:${JSON.stringify(options)}`);
      return quitResults.shift();
    },
  };
  const quitWhenIdleForUpdate = loadQuitWhenIdle(context);
  await quitWhenIdleForUpdate({ version: "5.0.8+2222222" }, { info: () => events.push("wait") });
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

test("the update quit drains without cancelling while an ordinary quit keeps cancelling", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "electron", "main.cjs"), "utf8");
  assert.match(main, /if \(preserveActiveTurns\) await runtimeSupervisor\?\.shutdown\(\);\n\s*else await runtimeSupervisor\?\.shutdown\(\{ cancelActiveTurns: true, force: true \}\);/);
  assert.match(main, /const prepared = await updateController\.beginInstall\(\);[\s\S]*?await quitWhenIdleForUpdate\(prepared, logger\);/);
  assert.match(main, /createSourceUpdateController\(\{[\s\S]*?currentCommit: LAUNCHER_MANIFEST\.sourceCommit,/);
  assert.doesNotMatch(main, /createUpdateController\(/, "the fork never offers upstream release packages");
});
