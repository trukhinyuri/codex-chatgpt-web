const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const {
  EXIT_RESTART_BY_LAUNCHD,
  LAUNCH_AGENT_FLAG,
  agentBlocked,
  LAUNCH_AGENT_LABEL,
  SHOW_REQUEST_FILE,
  SINGLETON_LOCK_FILE,
  applicationBundleOf,
  createLaunchAgent,
  decideLaunch,
  launchAgentEligibility,
  launchAgentPlist,
  launchAgentPlistPath,
  launchedByLaunchAgent,
  parseServiceStatus,
  prepareLaunch,
  reconcileLoginItem,
  sameLauncherProfile,
  serviceDisabled,
  setLaunchAgentAutostart,
  systemLaunchAgentDependencies,
} = require("../electron/launch-agent.cjs");

// Every test here runs against fakes: nothing reaches launchctl, ~/Library/LaunchAgents or a real
// launcher. The only real files live in temporary folders.
const HOME = "/Users/example";
const USER_DATA = `${HOME}/Library/Application Support/Codex Web GPT`;
const EXECUTABLE = "/Applications/Codex Web GPT.app/Contents/MacOS/Codex Web GPT";
const MOVED_EXECUTABLE = "/Users/example/Applications/Codex Web GPT.app/Contents/MacOS/Codex Web GPT";
const PLIST = launchAgentPlistPath(HOME);
const TARGET = `gui/501/${LAUNCH_AGENT_LABEL}`;
const SHOW_REQUEST = path.join(USER_DATA, SHOW_REQUEST_FILE);
const SUPERVISED_PID = 4242;

function unescapeXml(value) {
  return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");
}

/**
 * A fake Mac: files, launchd and the single-instance lock. A supervised launcher that launchd starts
 * takes the lock `startupMs` later, unless the caller still holds it or `neverStarts` is set.
 */
function fakeMac({
  files = {},
  loaded = false,
  loadedProgram = null,
  running = false,
  failures = {},
  startupMs = 600,
  neverStarts = false,
  bootstrapTransientFailures = 0,
} = {}) {
  const store = new Map(Object.entries(files));
  const events = [];
  const logs = [];
  let clock = Date.parse("2026-09-18T12:00:00Z");
  let transient = bootstrapTransientFailures;
  const launchd = { loaded, program: loadedProgram, running, startedAt: running ? clock - 60_000 : null };
  const lock = {
    held: true,
    elsewhere: false,
    request(data) {
      events.push(["lock.request", data]);
      if (this.elsewhere || holder() !== null) return false;
      this.held = true;
      return true;
    },
    release() {
      events.push(["lock.release"]);
      this.held = false;
    },
  };
  function holder() {
    if (neverStarts || !launchd.running || launchd.startedAt === null || lock.held) return null;
    return clock - launchd.startedAt >= startupMs ? SUPERVISED_PID : null;
  }
  function start() {
    if (!launchd.running) {
      launchd.running = true;
      launchd.startedAt = clock;
    }
  }
  const deps = {
    readFile(file) {
      if (failures.read?.(file)) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return store.has(file) ? store.get(file) : null;
    },
    writeFile(file, content, mode) {
      events.push(["write", file, mode]);
      if (failures.write?.(file)) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      store.set(file, content);
    },
    removeFile(file) {
      events.push(["remove", file]);
      store.delete(file);
    },
    launchctl(args) {
      events.push(["launchctl", ...args]);
      const [verb] = args;
      if (verb === "print") {
        if (!launchd.loaded) return { status: 113, stdout: "", stderr: "Could not find service" };
        return {
          status: 0,
          stdout: `${TARGET} = {\n\tactive count = 1\n\tstate = ${launchd.running ? "running" : "not running"}\n\tprogram = ${launchd.program}\n${launchd.running ? "\tpid = 4242\n" : ""}}\n`,
        };
      }
      if (verb === "print-disabled") {
        return { status: 0, stdout: `disabled services = {\n\t"com.apple.x" => enabled\n\t"${LAUNCH_AGENT_LABEL}" => ${failures.disabled ? "disabled" : "enabled"}\n}\n` };
      }
      if (verb === "bootout") {
        if (failures.bootout || !launchd.loaded) return { status: failures.bootout ? 5 : 113 };
        Object.assign(launchd, { loaded: false, running: false, startedAt: null, program: null });
        return { status: 0 };
      }
      if (verb === "bootstrap") {
        if (failures.disabled) return { status: 119, stderr: "Bootstrap failed: 119: Service is disabled" };
        if (failures.bootstrap) return { status: 5, stderr: "Bootstrap failed: 5: Input/output error" };
        if (transient > 0) {
          transient -= 1;
          return { status: 5, stderr: "Bootstrap failed: 5: Input/output error" };
        }
        if (launchd.loaded) return { status: 5, stderr: "service already loaded" };
        const text = store.get(args[2]);
        launchd.loaded = true;
        launchd.program = unescapeXml(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(text)[1]);
        if (/<key>RunAtLoad<\/key>\s*<true\/>/.test(text)) start();
        return { status: 0 };
      }
      if (verb === "kickstart") {
        if (failures.kickstart || !launchd.loaded) return { status: failures.kickstart ? 1 : 113 };
        start();
        return { status: 0 };
      }
      throw new Error(`unexpected launchctl ${args.join(" ")}`);
    },
    lockHolderPid: () => holder(),
    now: () => clock,
    sleep: milliseconds => { clock += milliseconds; },
  };
  const agent = (executable = EXECUTABLE) => createLaunchAgent({
    executable,
    plistPath: PLIST,
    uid: 501,
    userDataDirectory: USER_DATA,
    deps,
  });
  return {
    agent,
    deps,
    lock,
    launchd,
    store,
    events,
    logs,
    log: (level, event, detail) => logs.push([level, event, detail]),
    advance: milliseconds => { clock += milliseconds; },
    launchctlVerbs: () => events.filter(event => event[0] === "launchctl").map(event => event[1]),
    indexOf: predicate => events.findIndex(predicate),
  };
}

function launch(mac, options = {}) {
  return prepareLaunch({
    agent: mac.agent(options.executable),
    eligible: true,
    launchedByAgent: false,
    agentWanted: true,
    show: true,
    lock: mac.lock,
    log: mac.log,
    ...options,
  });
}

test("the agent starts at login, restarts only after a crash and runs this bundle's executable", () => {
  const text = launchAgentPlist({ executable: EXECUTABLE });
  assert.equal(LAUNCH_AGENT_LABEL, "com.codex-superpower.launcher");
  assert.equal(PLIST, "/Users/example/Library/LaunchAgents/com.codex-superpower.launcher.plist");
  for (const pattern of [
    /<key>Label<\/key>\s*<string>com\.codex-superpower\.launcher<\/string>/,
    /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/Applications\/Codex Web GPT\.app\/Contents\/MacOS\/Codex Web GPT<\/string>\s*<string>--launched-by-launch-agent<\/string>\s*<\/array>/,
    /<key>RunAtLoad<\/key>\s*<true\/>/,
    /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/,
    /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/,
    /<key>ProcessType<\/key>\s*<string>Interactive<\/string>/,
    /<key>LimitLoadToSessionType<\/key>\s*<string>Aqua<\/string>/,
  ]) assert.match(text, pattern);
  assert.doesNotMatch(text, /<key>KeepAlive<\/key>\s*<true\/>/, "an intentional quit must stay quit");
  assert.equal(LAUNCH_AGENT_FLAG, "--launched-by-launch-agent");
  assert.equal(launchedByLaunchAgent(["/x", LAUNCH_AGENT_FLAG]), true);
  assert.equal(launchedByLaunchAgent(["/x", "--hidden"]), false);
  assert.notEqual(EXIT_RESTART_BY_LAUNCHD, 0, "a retry must be a non-zero exit so launchd restarts it");
  assert.throws(() => launchAgentPlist({ executable: "relative/path" }), /absolute path/);
  assert.throws(() => launchAgentPlist({ label: "bad label;rm", executable: EXECUTABLE }), /Invalid launch agent label/);
});

test("the plist is valid XML for plutil, with any bundle path escaped", { skip: process.platform !== "darwin" && "plutil is macOS-only" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cwg-launch-agent-plist-"));
  try {
    const executable = `/Users/example/Apps & <Tools> "Q" 'A'/Codex Web GPT.app/Contents/MacOS/Codex Web GPT`;
    const file = path.join(root, "agent.plist");
    fs.writeFileSync(file, launchAgentPlist({ executable }));
    const lint = spawnSync("/usr/bin/plutil", ["-lint", file], { encoding: "utf8" });
    assert.equal(lint.status, 0, lint.stdout + lint.stderr);
    const parsed = JSON.parse(spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }).stdout);
    assert.deepEqual(parsed, {
      Label: LAUNCH_AGENT_LABEL,
      ProgramArguments: [executable, LAUNCH_AGENT_FLAG],
      RunAtLoad: true,
      KeepAlive: { SuccessfulExit: false },
      ThrottleInterval: 10,
      ProcessType: "Interactive",
      LimitLoadToSessionType: "Aqua",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("only the installed production app of the default profile manages the agent", () => {
  const base = { platform: "darwin", packaged: true, developmentProfile: false, smokeTest: false, defaultProfile: true, executable: EXECUTABLE };
  assert.deepEqual(launchAgentEligibility(base), { eligible: true, reason: null });
  for (const [patch, reason] of [
    [{ platform: "linux" }, "unsupported-platform"],
    [{ platform: "win32" }, "unsupported-platform"],
    [{ packaged: false }, "not-packaged"],
    [{ developmentProfile: true }, "development-profile"],
    [{ smokeTest: true }, "smoke-test"],
    [{ defaultProfile: false }, "custom-profile"],
    [{ executable: "/usr/local/bin/codex-web-gpt" }, "not-in-bundle"],
    [{ executable: "/private/var/folders/x/T/AppTranslocation/1234/d/Codex Web GPT.app/Contents/MacOS/Codex Web GPT" }, "translocated"],
  ]) assert.deepEqual(launchAgentEligibility({ ...base, ...patch }), { eligible: false, reason }, reason);
  assert.equal(applicationBundleOf(EXECUTABLE), "/Applications/Codex Web GPT.app");
  assert.equal(applicationBundleOf("/Applications/Codex Web GPT.app/Contents/Resources/x"), null);

  const production = { kind: "production", coreHome: "/h/.codex-chatgpt-web", codexHome: "/h/.codex", userData: "/h/Library/Application Support/Codex Web GPT" };
  assert.equal(sameLauncherProfile(production, { ...production, coreHome: "/h/.codex-chatgpt-web/" }), true);
  assert.equal(sameLauncherProfile(production, { ...production, codexHome: "/tmp/codex-home" }), false);
  assert.equal(sameLauncherProfile(production, { ...production, kind: "development" }), false);
});

test("the start decision: launchd's start runs, any other start hands off while the agent is wanted", () => {
  const rows = [];
  for (const eligible of [true, false]) {
    for (const launchedByAgent of [true, false]) {
      for (const agentWanted of [true, false]) rows.push([eligible, launchedByAgent, agentWanted, decideLaunch({ eligible, launchedByAgent, agentWanted })]);
    }
  }
  assert.deepEqual(rows, [
    [true, true, true, "supervised"],
    [true, true, false, "supervised"],
    [true, false, true, "hand-off"],
    [true, false, false, "in-process"],
    [false, true, true, "in-process"],
    [false, true, false, "in-process"],
    [false, false, true, "in-process"],
    [false, false, false, "in-process"],
  ]);
});

test("a first start installs the agent, releases the lock before launchd starts, and exits once launchd's launcher holds the lock", () => {
  const mac = fakeMac();
  const result = launch(mac);
  assert.deepEqual(result, { mode: "hand-off", exit: true, showRequested: false, code: null });
  assert.equal(mac.store.get(PLIST), launchAgentPlist({ executable: EXECUTABLE }));
  assert.deepEqual(mac.events.find(event => event[0] === "write" && event[1] === PLIST), ["write", PLIST, 0o644]);
  assert.deepEqual(mac.launchctlVerbs(), ["print", "print-disabled", "bootstrap", "kickstart"]);
  const showRequest = mac.indexOf(event => event[0] === "write" && event[1] === SHOW_REQUEST);
  const release = mac.indexOf(event => event[0] === "lock.release");
  const firstLaunchctl = mac.indexOf(event => event[0] === "launchctl");
  assert.ok(showRequest >= 0 && showRequest < release, "the show request is in place before launchd can start the launcher");
  assert.ok(release < firstLaunchctl, "the lock is free before launchd starts the supervised launcher");
  assert.equal(mac.events.filter(event => event[0] === "lock.request").length, 0, "a successful hand-off never takes the lock back");
  assert.ok(mac.store.has(SHOW_REQUEST), "the supervised launcher finds the user's request to show its window");
  assert.deepEqual(mac.logs.at(-1).slice(0, 2), ["info", "launch_agent.handed_off"]);
});

test("a start of an unchanged, loaded agent only kickstarts it", () => {
  const plist = launchAgentPlist({ executable: EXECUTABLE });
  const mac = fakeMac({ files: { [PLIST]: plist }, loaded: true, loadedProgram: EXECUTABLE });
  assert.equal(launch(mac).exit, true);
  assert.deepEqual(mac.launchctlVerbs(), ["print", "kickstart"]);
  assert.equal(mac.events.some(event => event[0] === "write" && event[1] === PLIST), false, "an unchanged plist is not rewritten");
});

test("a moved or renamed app rewrites the plist and reloads the agent before kickstarting it", () => {
  const mac = fakeMac({
    files: { [PLIST]: launchAgentPlist({ executable: EXECUTABLE }) },
    loaded: true,
    loadedProgram: EXECUTABLE,
  });
  assert.equal(launch(mac, { executable: MOVED_EXECUTABLE }).exit, true);
  assert.equal(mac.store.get(PLIST), launchAgentPlist({ executable: MOVED_EXECUTABLE }));
  assert.deepEqual(mac.launchctlVerbs(), ["print", "bootout", "print", "print", "print-disabled", "bootstrap", "kickstart"]);
  assert.equal(mac.launchd.program, MOVED_EXECUTABLE, "launchd runs the app from its new place");

  // The file already names this app but launchd still holds an older definition.
  const stale = fakeMac({
    files: { [PLIST]: launchAgentPlist({ executable: MOVED_EXECUTABLE }) },
    loaded: true,
    loadedProgram: EXECUTABLE,
  });
  assert.equal(launch(stale, { executable: MOVED_EXECUTABLE }).exit, true);
  assert.ok(stale.launchctlVerbs().includes("bootout") && stale.launchctlVerbs().includes("bootstrap"));
  assert.equal(stale.launchd.program, MOVED_EXECUTABLE);
});

test("a bootstrap that fails right after a bootout is retried", () => {
  const mac = fakeMac({ bootstrapTransientFailures: 2 });
  assert.equal(launch(mac).exit, true);
  assert.equal(mac.launchctlVerbs().filter(verb => verb === "bootstrap").length, 3);
});

test("a hand-off that cannot install or start the agent keeps this launcher running and logs a fixed code", () => {
  for (const [failures, code, verbs] of [
    [{ write: file => file === PLIST }, "plist-write-failed", []],
    // Retried for a few seconds, never followed by a kickstart.
    [{ bootstrap: true }, "bootstrap-failed", ["print-disabled", "bootstrap"]],
  ]) {
    const mac = fakeMac({ failures });
    const result = launch(mac);
    assert.deepEqual(result, { mode: "in-process", exit: false, showRequested: false, code }, code);
    assert.deepEqual([...new Set(mac.launchctlVerbs().filter(verb => verb !== "print"))].sort(), [...verbs].sort(), code);
    assert.equal(mac.lock.held, true, `${code}: the lock is taken back`);
    assert.equal(mac.store.has(SHOW_REQUEST), false, `${code}: no stale show request is left for a later start`);
    assert.deepEqual(mac.logs.find(entry => entry[1] === "launch_agent.handoff_failed"), ["warn", "launch_agent.handoff_failed", { code }]);
  }
  // A loaded agent that launchd refuses to start.
  const plist = launchAgentPlist({ executable: EXECUTABLE });
  const refused = fakeMac({ files: { [PLIST]: plist }, loaded: true, loadedProgram: EXECUTABLE, failures: { kickstart: true } });
  assert.deepEqual(launch(refused), { mode: "in-process", exit: false, showRequested: false, code: "kickstart-failed" });
  assert.equal(refused.lock.held, true);
  assert.deepEqual(refused.events.find(event => event[0] === "lock.request"), ["lock.request", { show: true }]);
});

test("an agent switched off in System Settings or by MDM is not retried: this start keeps running and reports it", () => {
  const mac = fakeMac({ failures: { disabled: true } });
  assert.deepEqual(launch(mac), { mode: "in-process", exit: false, showRequested: false, code: "agent-disabled" });
  assert.deepEqual(mac.launchctlVerbs(), ["print", "print-disabled"], "no bootstrap loop against a refused service");
  assert.equal(mac.lock.held, true);
  // A plist macOS refuses still counts as installed: the login item does not come back behind the
  // user's or the admin's decision, and Settings says why nothing starts.
  const legacy = { state: true, enabled: () => legacy.state, set: value => { legacy.state = value; } };
  reconcileLoginItem({ agent: mac.agent(), agentWanted: true, loginItem: legacy, log: mac.log });
  assert.equal(legacy.state, false);
  const settings = setLaunchAgentAutostart({ agent: mac.agent(), enabled: true, supervised: false, loginItem: legacy, log: mac.log });
  assert.deepEqual(settings, { supported: true, enabled: true, launchAgent: true, blocked: true });
  assert.equal(agentBlocked(mac.agent()), true);

  // A bootstrap refused as disabled (the list did not say so yet) stops at once, too.
  const refused = fakeMac({ failures: { bootstrap: true } });
  const agent = refused.agent();
  let calls = 0;
  const original = refused.deps.launchctl;
  refused.deps.launchctl = args => {
    if (args[0] === "bootstrap") {
      calls += 1;
      return { status: 119, stderr: "Bootstrap failed: 119: Service is disabled" };
    }
    return original(args);
  };
  assert.equal(agent.bootstrap().ok, false);
  assert.equal(calls, 1);
  assert.deepEqual(serviceDisabledCases(), [true, false, true, false]);
});

function serviceDisabledCases() {
  return [
    serviceDisabled(`disabled services = {\n\t"${LAUNCH_AGENT_LABEL}" => disabled\n}`, LAUNCH_AGENT_LABEL),
    serviceDisabled(`\t"${LAUNCH_AGENT_LABEL}" => enabled`, LAUNCH_AGENT_LABEL),
    serviceDisabled(`\t"${LAUNCH_AGENT_LABEL}" => true`, LAUNCH_AGENT_LABEL),
    serviceDisabled(`\t"${LAUNCH_AGENT_LABEL}.other" => disabled`, LAUNCH_AGENT_LABEL),
  ];
}

test("a launcher launchd never brings up is kickstarted again, then this start keeps running", () => {
  const mac = fakeMac({ neverStarts: true });
  const result = launch(mac);
  assert.deepEqual(result, { mode: "in-process", exit: false, showRequested: false, code: "handoff-timeout" });
  const kicks = mac.launchctlVerbs().filter(verb => verb === "kickstart").length;
  assert.ok(kicks >= 6, `kickstarted every five seconds for thirty seconds (${kicks})`);
  assert.equal(mac.lock.held, true);
});

test("when another launcher takes the lock during a failed hand-off, this start leaves it to that one", () => {
  const plist = launchAgentPlist({ executable: EXECUTABLE });
  const mac = fakeMac({ files: { [PLIST]: plist }, loaded: true, loadedProgram: EXECUTABLE, failures: { kickstart: true } });
  mac.lock.elsewhere = true;
  assert.deepEqual(launch(mac, { show: false }), { mode: "hand-off", exit: true, showRequested: false, code: "kickstart-failed" });
  assert.deepEqual(mac.events.find(event => event[0] === "lock.request"), ["lock.request", { show: false }], "a hidden start never asks the other launcher to show its window");
});

test("a hidden start (login, --hidden) hands off without asking for the window", () => {
  const mac = fakeMac();
  assert.equal(launch(mac, { show: false }).exit, true);
  assert.equal(mac.store.has(SHOW_REQUEST), false);
});

test("the supervised launcher never touches launchd or the lock and keeps its plist current", () => {
  const mac = fakeMac({ files: { [PLIST]: "<!-- an older format -->" }, loaded: true, loadedProgram: EXECUTABLE, running: true });
  mac.store.set(SHOW_REQUEST, JSON.stringify({ version: 1, at: new Date(mac.deps.now() - 5_000).toISOString() }));
  const result = launch(mac, { launchedByAgent: true });
  assert.deepEqual(result, { mode: "supervised", exit: false, showRequested: true, code: null });
  assert.equal(mac.store.get(PLIST), launchAgentPlist({ executable: EXECUTABLE }), "the plist is rewritten for the next load");
  assert.deepEqual(mac.launchctlVerbs(), [], "no bootout of its own job, no bootstrap, no kickstart");
  assert.equal(mac.events.some(event => event[0].startsWith("lock.")), false);
  assert.equal(mac.store.has(SHOW_REQUEST), false, "the show request is used once");

  // A request older than two minutes belongs to an earlier, failed start.
  const stale = fakeMac({ files: { [PLIST]: launchAgentPlist({ executable: EXECUTABLE }) }, loaded: true, running: true });
  stale.store.set(SHOW_REQUEST, JSON.stringify({ version: 1, at: new Date(stale.deps.now() - 3 * 60_000).toISOString() }));
  assert.equal(launch(stale, { launchedByAgent: true }).showRequested, false);
  assert.equal(stale.store.has(SHOW_REQUEST), false);
  const corrupt = fakeMac({ loaded: true, running: true });
  corrupt.store.set(SHOW_REQUEST, "{");
  assert.equal(launch(corrupt, { launchedByAgent: true }).showRequested, false);
});

test("turning the agent off removes it; only an unsupervised launcher unloads it", () => {
  const plist = launchAgentPlist({ executable: EXECUTABLE });
  const supervised = fakeMac({ files: { [PLIST]: plist }, loaded: true, running: true });
  assert.equal(launch(supervised, { launchedByAgent: true, agentWanted: false }).mode, "supervised");
  assert.equal(supervised.store.has(PLIST), false);
  assert.deepEqual(supervised.launchctlVerbs(), [], "a supervised launcher never unloads its own job: that would stop it now");

  const unsupervised = fakeMac({ files: { [PLIST]: plist }, loaded: true });
  assert.deepEqual(launch(unsupervised, { agentWanted: false }), { mode: "in-process", exit: false, showRequested: false, code: null });
  assert.equal(unsupervised.store.has(PLIST), false);
  assert.deepEqual(unsupervised.launchctlVerbs(), ["print", "bootout", "print"]);
  assert.equal(unsupervised.events.some(event => event[0].startsWith("lock.")), false);
});

test("a launcher that may not manage the agent never touches it", () => {
  const mac = fakeMac({ files: { [PLIST]: "user's own" }, loaded: true });
  for (const options of [{ eligible: false }, { agent: null }, { eligible: false, launchedByAgent: true }]) {
    const result = prepareLaunch({ agent: null, eligible: true, launchedByAgent: false, agentWanted: true, show: true, lock: mac.lock, log: mac.log, ...options, ...(options.agent === undefined ? { agent: mac.agent() } : {}) });
    assert.deepEqual(result, { mode: "in-process", exit: false, showRequested: false, code: null });
  }
  assert.deepEqual(mac.events, []);
  assert.equal(mac.store.get(PLIST), "user's own");
});

test("migration: the agent replaces the login item of earlier builds, which stays only as a fallback", () => {
  const loginItem = (enabled) => {
    const item = { state: enabled, sets: [], enabled: () => item.state, set: value => { item.sets.push(value); item.state = value; } };
    return item;
  };
  const installed = fakeMac({ files: { [PLIST]: launchAgentPlist({ executable: EXECUTABLE }) } });
  const legacy = loginItem(true);
  assert.deepEqual(reconcileLoginItem({ agent: installed.agent(), agentWanted: true, loginItem: legacy, log: installed.log }), { loginItem: false });
  assert.deepEqual(legacy.sets, [false], "the app must not start twice at login");
  assert.deepEqual(installed.logs, [["info", "launch_agent.login_item_removed", { ok: true }]]);

  const unwritable = fakeMac();
  const fallback = loginItem(false);
  reconcileLoginItem({ agent: unwritable.agent(), agentWanted: true, loginItem: fallback, log: unwritable.log });
  assert.deepEqual(fallback.sets, [true], "without a plist the login item still starts the app at login");

  const off = loginItem(true);
  reconcileLoginItem({ agent: installed.agent(), agentWanted: false, loginItem: off, log: installed.log });
  assert.deepEqual(off.sets, [false]);

  const settled = loginItem(false);
  reconcileLoginItem({ agent: installed.agent(), agentWanted: true, loginItem: settled, log: installed.log });
  assert.deepEqual(settled.sets, []);

  const broken = { enabled: () => true, set: () => { throw new Error("SMAppService failed"); } };
  const logs = [];
  assert.deepEqual(reconcileLoginItem({ agent: installed.agent(), agentWanted: true, loginItem: broken, log: (...entry) => logs.push(entry) }), { loginItem: true });
  assert.deepEqual(logs, [["warn", "launch_agent.login_item_removed", { ok: false }]]);
});

test("migration end to end: the first start after the update hands off, the supervised start removes the login item", () => {
  const mac = fakeMac();
  const legacy = { state: true, enabled: () => legacy.state, set: value => { legacy.state = value; } };
  // `open` from the update worker: an earlier build, the login item on, no agent yet.
  assert.equal(launch(mac).exit, true);
  // launchd's start of the same app.
  const supervised = launch(mac, { launchedByAgent: true });
  assert.deepEqual(supervised, { mode: "supervised", exit: false, showRequested: true, code: null });
  reconcileLoginItem({ agent: mac.agent(), agentWanted: true, loginItem: legacy, log: mac.log });
  assert.equal(legacy.state, false);
  assert.equal(mac.launchd.loaded, true);
});

test("Start at login maps to the agent and never unloads a supervised launcher", () => {
  const loginItem = (state) => ({ state, enabled() { return this.state; }, set(value) { this.state = value; } });
  const mac = fakeMac({ loaded: true, running: true });
  const on = setLaunchAgentAutostart({ agent: mac.agent(), enabled: true, supervised: true, loginItem: loginItem(true), log: mac.log });
  assert.deepEqual(on, { supported: true, enabled: true, launchAgent: true, blocked: false });
  const changes = () => mac.launchctlVerbs().filter(verb => verb !== "print" && verb !== "print-disabled");
  assert.deepEqual(changes(), [], "only read-only launchctl queries");

  const offSupervised = setLaunchAgentAutostart({ agent: mac.agent(), enabled: false, supervised: true, loginItem: loginItem(false), log: mac.log });
  assert.deepEqual(offSupervised, { supported: true, enabled: false, launchAgent: false, blocked: false });
  assert.deepEqual(changes(), [], "the running launcher keeps crash protection until it quits");

  const idle = fakeMac({ files: { [PLIST]: launchAgentPlist({ executable: EXECUTABLE }) }, loaded: true });
  const offInProcess = setLaunchAgentAutostart({ agent: idle.agent(), enabled: false, supervised: false, loginItem: loginItem(true), log: idle.log });
  assert.deepEqual(offInProcess, { supported: true, enabled: false, launchAgent: false, blocked: false });
  assert.deepEqual(idle.launchctlVerbs(), ["print", "bootout", "print"]);

  const unwritable = fakeMac({ failures: { write: file => file === PLIST } });
  const fallback = setLaunchAgentAutostart({ agent: unwritable.agent(), enabled: true, supervised: false, loginItem: loginItem(false), log: unwritable.log });
  assert.deepEqual(fallback, { supported: true, enabled: true, launchAgent: false, blocked: false }, "the login item carries the setting when the plist cannot be written");
  assert.ok(unwritable.logs.some(entry => entry[1] === "launch_agent.install_failed" && entry[2].code === "plist-write-failed"));
});

test("the agent refuses to run without explicit dependencies, so a test can never reach launchctl", () => {
  assert.throws(() => createLaunchAgent({ executable: EXECUTABLE, plistPath: PLIST, uid: 501, userDataDirectory: USER_DATA }), /dependency readFile is missing/);
  const { deps } = fakeMac();
  assert.throws(() => createLaunchAgent({ executable: EXECUTABLE, plistPath: "relative.plist", uid: 501, userDataDirectory: USER_DATA, deps }), /absolute plist path/);
  assert.throws(() => createLaunchAgent({ executable: EXECUTABLE, plistPath: PLIST, uid: -1, userDataDirectory: USER_DATA, deps }), /user id/);
});

test("launchctl print is read for the loaded program and pid", () => {
  assert.deepEqual(parseServiceStatus(`${TARGET} = {\n\tstate = running\n\tprogram = ${EXECUTABLE}\n\tpid = 812\n}`), { program: EXECUTABLE, pid: 812, running: true });
  assert.deepEqual(parseServiceStatus("gui/501/x = {\n\tstate = not running\n}"), { program: null, pid: null, running: false });
  assert.equal(parseServiceStatus("\tprogram = (null)\n").program, null);
});

test("the real file and lock helpers work on a temporary folder", { skip: process.platform === "win32" && "POSIX symlinks" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cwg-launch-agent-system-"));
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  try {
    const deps = systemLaunchAgentDependencies({ userDataDirectory: root });
    const plist = path.join(root, "LaunchAgents", "x.plist");
    assert.equal(deps.readFile(plist), null);
    deps.writeFile(plist, "content", 0o644);
    assert.equal(deps.readFile(plist), "content");
    assert.equal(fs.statSync(plist).mode & 0o777, 0o644, "launchd refuses a group- or world-writable plist");
    assert.deepEqual(fs.readdirSync(path.dirname(plist)), ["x.plist"], "no temporary file is left");
    deps.removeFile(plist);
    assert.equal(deps.readFile(plist), null);

    const lock = path.join(root, SINGLETON_LOCK_FILE);
    assert.equal(deps.lockHolderPid(), null);
    fs.symlinkSync(`host.local-${child.pid}`, lock);
    assert.equal(deps.lockHolderPid(), child.pid);
    fs.rmSync(lock);
    fs.symlinkSync(`host.local-${process.pid}`, lock);
    assert.equal(deps.lockHolderPid(), null, "this process's own lock is not a hand-off");
    fs.rmSync(lock);
    const exited = spawnSync("/usr/bin/true");
    fs.symlinkSync(`host.local-${exited.pid}`, lock);
    assert.equal(deps.lockHolderPid(), null, "a lock left by a dead launcher is not a hand-off");
    const start = Date.now();
    deps.sleep(20);
    assert.ok(Date.now() - start >= 15);
  } finally {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the installer unloads exactly the agents that the apps' Info.plist name, and forgets it for an older build", { skip: process.platform !== "darwin" && "plutil is macOS-only" }, () => {
  const installer = fs.readFileSync(path.join(__dirname, "..", "..", "scripts", "install-fork-macos.sh"), "utf8");
  const functions = ["agent_label", "unload_launch_agent", "forget_launch_agent_for_older_build"].map(name => {
    const source = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, "m").exec(installer)?.[0];
    assert.ok(source, `install-fork-macos.sh defines ${name}`);
    return source;
  }).join("");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cwg-launch-agent-installer-"));
  try {
    const app = (name, label) => {
      const bundle = path.join(root, `${name}.app`);
      fs.mkdirSync(path.join(bundle, "Contents"), { recursive: true });
      if (label !== undefined) {
        fs.writeFileSync(path.join(bundle, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CodexWebGptLaunchAgentLabel</key><string>${label}</string></dict></plist>
`);
      }
      return bundle;
    };
    const record = path.join(root, "launchctl.log");
    // launchctl is a shell function here, which bash prefers to any program, and /bin (where the real
    // one lives) is not on PATH: nothing reaches launchd.
    const script = `launchctl() { printf '%s\\n' "$*" >> "$RECORD"; }\n${functions}unload_launch_agent "$@"\n`;
    const result = spawnSync("/bin/bash", ["-c", script, "unload",
      app("Supervised", "com.example.codex-superpower-test"),
      app("Hostile", "x; touch pwned"),
      app("Older build"),
      path.join(root, "Missing.app"),
    ], { encoding: "utf8", env: { PATH: "/usr/bin", RECORD: record }, cwd: root });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readFileSync(record, "utf8").trim().split("\n"), [`bootout gui/${process.getuid()}/com.example.codex-superpower-test`]);
    assert.equal(fs.existsSync(path.join(root, "pwned")), false);

    // HOME is the temporary folder: only its LaunchAgents/ is touched.
    const agents = path.join(root, "Library", "LaunchAgents");
    fs.mkdirSync(agents, { recursive: true });
    const forget = (installed, label) => {
      const plist = path.join(agents, "com.example.codex-superpower-test.plist");
      fs.writeFileSync(plist, "<plist/>");
      const run = spawnSync("/bin/bash", ["-c", `${functions}forget_launch_agent_for_older_build "$1" "$2"`, "forget", installed, label], {
        // forget_… never runs launchctl; /bin is on PATH for rm.
        encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: root }, cwd: root,
      });
      assert.equal(run.status, 0, run.stderr);
      return fs.existsSync(plist);
    };
    assert.equal(forget(app("Older build"), "com.example.codex-superpower-test"), false, "an older build must not start twice at login");
    assert.equal(forget(app("Supervised"), "com.example.codex-superpower-test"), true, "a build that knows the agent keeps it");
    assert.equal(forget(app("Older build"), ""), true, "no label, nothing to remove");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("one label names the agent in the package, the scripts and the update job", () => {
  const read = (...parts) => fs.readFileSync(path.join(__dirname, "..", "..", ...parts), "utf8");
  const packageScript = read("launcher", "scripts", "package.cjs");
  assert.match(packageScript, /const \{ LAUNCH_AGENT_LABEL \} = require\("\.\.\/electron\/launch-agent\.cjs"\);/);
  assert.match(packageScript, /--config\.mac\.extendInfo\.CodexWebGptLaunchAgentLabel=\$\{LAUNCH_AGENT_LABEL\}/);
  for (const script of ["install-fork-macos.sh", "rollback-fork-macos.sh"]) {
    const source = read("scripts", script);
    assert.match(source, /plutil -extract CodexWebGptLaunchAgentLabel raw/, script);
    assert.match(source, /launchctl bootout "gui\/\$\(id -u\)\/\$label"/, script);
    assert.doesNotMatch(source, /com\.codex-superpower\.launcher/, `${script} reads the label instead of repeating it`);
    // The agent is unloaded after the launcher quit and before the app is moved.
    const quit = source.indexOf("Quitting Codex Web GPT");
    const unload = source.indexOf("launchctl bootout");
    const move = source.search(/\nmv "\$APP"|\n  mv "\$APP"/);
    assert.ok(quit >= 0 && quit < unload && unload < move, script);
  }
  const main = read("launcher", "electron", "main.cjs");
  assert.match(main, /launchAgentLabel: launchAgent \? LAUNCH_AGENT_LABEL : null/);
  assert.equal((main.match(/com\.codex-superpower\.launcher/g) || []).length, 0);
});
