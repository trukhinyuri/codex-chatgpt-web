const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const launchAgentModule = require("../electron/launch-agent.cjs");
const { requireAutostartState } = require("../electron/autostart.cjs");

// main.cjs requires Electron, so its pieces run here in a VM against fakes, like the other wiring
// tests. Nothing starts a launcher, touches launchd or writes outside the test.
const launcherRoot = path.resolve(__dirname, "..");
const electronMain = fs.readFileSync(path.join(launcherRoot, "electron", "main.cjs"), "utf8");
const appSource = fs.readFileSync(path.join(launcherRoot, "src", "App.tsx"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(launcherRoot, "package.json"), "utf8"));
const packageScript = fs.readFileSync(path.join(launcherRoot, "scripts", "package.cjs"), "utf8");

// Objects made inside a VM have another realm's prototypes; compare their JSON.
const plain = value => JSON.parse(JSON.stringify(value));

function slice(from, to) {
  const start = electronMain.indexOf(from);
  const end = electronMain.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `main.cjs contains ${from} … ${to}`);
  return electronMain.slice(start, end);
}

function trayHarness(platform, initialTray = null) {
  const created = [];
  const context = {
    process: { platform },
    tray: initialTray,
    Boolean,
    LAUNCHER_PROFILE: { displayName: "Codex Web GPT" },
    trayImage: () => "tray-image",
    updateTrayMenu() {},
    showMainWindow() {},
    Tray: class {
      constructor(image) {
        this.image = image;
        this.destroyed = false;
        created.push(this);
      }
      setToolTip() {}
      on() {}
      destroy() { this.destroyed = true; }
    },
  };
  vm.createContext(context);
  vm.runInContext(`${slice("function createTray(", "function showMainWindow()")}
globalThis.api = { trayWanted, syncTray, closeHidesWindow };`, context);
  const logger = { warn: () => {} };
  return { context, created, api: context.api, logger };
}

test("macOS: the menu-bar icon is off by default and appears only when the user turns it on", () => {
  const mac = trayHarness("darwin");
  assert.equal(mac.api.syncTray(mac.logger, { showInMenuBar: false, language: "en" }), false);
  assert.equal(mac.created.length, 0, "no menu-bar icon for new or migrated users");
  assert.equal(mac.api.syncTray(mac.logger, { showInMenuBar: true, language: "en" }), true);
  assert.equal(mac.created.length, 1, "the existing tray code path creates the icon");
  assert.equal(mac.api.syncTray(mac.logger, { showInMenuBar: true, language: "en" }), true);
  assert.equal(mac.created.length, 1, "turning it on twice keeps one icon");
  const icon = mac.context.tray;
  assert.equal(mac.api.syncTray(mac.logger, { showInMenuBar: false, language: "en" }), false);
  assert.equal(icon.destroyed, true);
  assert.equal(mac.context.tray, null);
});

test("Windows and Linux keep their tray icon: it is how a hidden window comes back there", () => {
  for (const platform of ["win32", "linux"]) {
    const other = trayHarness(platform);
    assert.equal(other.api.syncTray(other.logger, { showInMenuBar: false, language: "en" }), true, platform);
    assert.equal(other.created.length, 1, platform);
  }
});

test("closing the window keeps the launcher running: the Dock reopens it on macOS, the tray elsewhere", () => {
  const mac = trayHarness("darwin");
  assert.equal(mac.api.closeHidesWindow({ keepRunningOnClose: true }), true, "no menu-bar icon needed: the Dock brings it back");
  assert.equal(mac.api.closeHidesWindow({ keepRunningOnClose: false }), false);
  const linuxWithoutTray = trayHarness("linux");
  assert.equal(linuxWithoutTray.api.closeHidesWindow({ keepRunningOnClose: true }), false, "without a tray a hidden window could not come back");
  const linuxWithTray = trayHarness("linux", { destroy() {} });
  assert.equal(linuxWithTray.api.closeHidesWindow({ keepRunningOnClose: true }), true);
  // Hiding is the only close path that keeps running; the other one asks before stopping turns.
  assert.match(electronMain, /if \(closeHidesWindow\(stateStore\.read\(\)\)\) window\.hide\(\);\s*else void quitAfterConfirmation\(\);/);
});

test("a click on the Dock icon shows the hidden window, and nothing hides the app from the Dock", () => {
  const start = slice("async function start()", "\nvoid start().catch(");
  const activate = start.indexOf('app.on("activate", () => showMainWindow());');
  assert.ok(activate >= 0, "the Dock's reopen event shows the window");
  assert.ok(activate < start.indexOf("await waitForPackagedRuntimeSource"), "registered before startup can block");
  const shows = [];
  const context = {
    mainWindow: { isDestroyed: () => false, isMinimized: () => false, show: () => shows.push("show"), focus: () => shows.push("focus"), restore() {} },
    mainWindowReadyToShow: true,
    mainWindowShowRequested: false,
    startupFailed: false,
  };
  vm.createContext(context);
  vm.runInContext(`${slice("function showMainWindow()", "async function openWebUrl")}\nglobalThis.show = showMainWindow;`, context);
  context.show();
  assert.deepEqual(shows, ["show", "focus"]);
  // A normal Dock app: no LSUIElement, no dock.hide(), no accessory activation policy.
  assert.equal(JSON.stringify(manifest.build).includes("LSUIElement"), false);
  assert.doesNotMatch(packageScript, /LSUIElement/);
  assert.doesNotMatch(electronMain, /app\.dock\.hide|setActivationPolicy|LSUIElement/);
});

test("Settings says when macOS keeps the agent from running", () => {
  assert.match(slice('handle("launcher:snapshot"', 'const cliproxy = createCliProxyPanel'),
    /autostartBlocked: Boolean\(launchAgent\) && stateStore\.read\(\)\.autoStart === true && agentBlocked\(launchAgent\)/);
  assert.match(appSource, /useState\(snapshot\.autostartBlocked === true\)/);
  assert.match(appSource, /autostartBlocked && snapshot\.state\.autoStart\s*\? copy\.launchAtLoginBlocked/);
  assert.match(appSource, /setAutostartBlocked\(result\.blocked === true\)/);
});

test("Settings offers \"Show in menu bar\" on macOS only and saves it as a preference", () => {
  assert.match(appSource, /\{snapshot\.platform === "darwin" \? <SettingRow body=\{copy\.showInMenuBarBody\} label=\{copy\.showInMenuBar\}>/);
  assert.match(appSource, /checked=\{snapshot\.state\.showInMenuBar\}[\s\S]*?setPreference\("showInMenuBar", checked\)/);
  const preference = slice('handle("launcher:set-preference"', 'handle("launcher:sidebar-state"');
  assert.match(preference, /\|\| key === "showInMenuBar"/);
  assert.match(preference, /if \(key === "showInMenuBar"\) syncTray\(logger, state\);/);
  assert.match(electronMain, /const trayAvailable = syncTray\(logger, stateStore\.read\(\)\);/);
  assert.match(electronMain, /if \(startHidden && !trayAvailable && process\.platform !== "darwin"\)/);
});

function quitHarness({ operation = null } = {}) {
  const events = [];
  const context = {
    shutdownInProgress: false,
    exitCommitted: false,
    quitting: false,
    runtimeHost: { currentOperation: () => operation },
    browserHost: {
      currentOperation: () => null,
      persistSession: async () => events.push("persist"),
      destroy: () => events.push("destroy"),
    },
    runtimeSupervisor: { shutdown: async options => events.push(["shutdown", options ?? null]) },
    browserControl: { close: async () => events.push("control-closed") },
    stopCatalogVerificationMonitor: () => events.push("monitor-stopped"),
    showMainWindow: () => events.push("show"),
    publishOperation: operation => events.push(["operation", operation.status]),
    app: { quit: () => events.push("app.quit"), exit: code => events.push(["app.exit", code]) },
    Error,
    String,
  };
  vm.createContext(context);
  vm.runInContext(`${slice("async function requestQuit(", "function reportLauncherStartup(")}\nglobalThis.requestQuit = requestQuit;`, context);
  return { context, events };
}

test("an intentional quit (menu, Cmd+Q, Dock, SIGTERM, update) exits through app.quit, which exits 0", async () => {
  const quit = quitHarness();
  assert.deepEqual(plain(await quit.context.requestQuit()), { ok: true });
  assert.deepEqual(plain(quit.events), [
    ["shutdown", { cancelActiveTurns: true, force: true }],
    "monitor-stopped",
    "persist",
    "destroy",
    "control-closed",
    "app.quit",
  ]);
  assert.equal(quit.events.some(event => Array.isArray(event) && event[0] === "app.exit"), false, "never a non-zero exit that launchd would restart");

  const update = quitHarness();
  assert.deepEqual(plain(await update.context.requestQuit({ preserveActiveTurns: true, quiet: true })), { ok: true });
  assert.deepEqual(update.events[0], ["shutdown", null], "an update drains turns instead of cancelling them");
  assert.equal(update.events.at(-1), "app.quit", "the update quit is intentional: launchd must not restart the old app mid-swap");

  const busy = quitHarness({ operation: "model setup" });
  const refused = await busy.context.requestQuit();
  assert.equal(refused.ok, false);
  assert.equal(busy.events.includes("app.quit"), false);

  // Every quit path reaches requestQuit: the confirmation, SIGINT/SIGTERM (launchd's bootout and
  // logout) and the update.
  assert.match(electronMain, /process\.once\("SIGTERM", \(\) => \{ void requestQuit\(\); \}\);/);
  assert.match(electronMain, /await requestQuit\(\{ preserveActiveTurns: !wait\.now, quiet: true \}\)/);
  assert.match(slice("async function quitAfterConfirmation()", "async function requestQuit("), /await requestQuit\(\);/);
});

function startupFailureHarness({ launchedByAgent, answer }) {
  const events = [];
  const window = { isDestroyed: () => false, isMinimized: () => false, show() {}, focus() {} };
  const context = {
    mainWindow: window, mainWindowReadyToShow: false, mainWindowShowRequested: false, startupFailed: false, quitting: false,
    reportLauncherStartup: () => {},
    browserHost: { destroy() {} },
    browserControl: { close: async () => {} },
    start: async () => { throw new Error("startup failed"); },
    app: {
      getPath: () => "/unused",
      whenReady: async () => {},
      relaunch: options => events.push(["relaunch", Array.from(options.args)]),
      exit: code => events.push(["exit", code]),
    },
    fs: { appendFileSync() {} },
    path,
    createStateStore: () => ({ read: () => ({ language: "en" }) }),
    nativeCopyFor: () => ({ startupTitle: "t", startupDetail: "d", startupCleanupFailed: "c", retry: "Retry", quit: "Quit" }),
    launchEnvironment: {},
    LAUNCHED_BY_AGENT: launchedByAgent,
    launchAgent: launchedByAgent ? { requestShow: () => events.push("show-request") } : null,
    LAUNCH_AGENT_FLAG: launchAgentModule.LAUNCH_AGENT_FLAG,
    EXIT_RESTART_BY_LAUNCHD: launchAgentModule.EXIT_RESTART_BY_LAUNCHD,
    process: { argv: ["launcher", ...(launchedByAgent ? [launchAgentModule.LAUNCH_AGENT_FLAG] : ["--hidden"])], env: {} },
    dialog: { showMessageBox: async () => ({ response: answer }) },
  };
  vm.createContext(context);
  vm.runInContext(slice("function showMainWindow()", "async function openWebUrl") + electronMain.slice(electronMain.indexOf("void start().catch(")), context);
  return events;
}

test("a failed start: Quit exits 0 so launchd leaves it stopped; a supervised Retry leaves the restart to launchd", async () => {
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  const supervisedRetry = startupFailureHarness({ launchedByAgent: true, answer: 0 });
  await settle();
  assert.deepEqual(supervisedRetry, ["show-request", ["exit", launchAgentModule.EXIT_RESTART_BY_LAUNCHD]],
    "no relaunch next to launchd's own restart, and the restarted launcher shows the window the user asked for");
  const supervisedQuit = startupFailureHarness({ launchedByAgent: true, answer: 1 });
  await settle();
  assert.deepEqual(supervisedQuit, [["exit", 0]]);
  const unsupervisedRetry = startupFailureHarness({ launchedByAgent: false, answer: 0 });
  await settle();
  assert.deepEqual(unsupervisedRetry, [["relaunch", []], ["exit", 1]]);
  const unsupervisedQuit = startupFailureHarness({ launchedByAgent: false, answer: 1 });
  await settle();
  assert.deepEqual(unsupervisedQuit, [["exit", 0]]);
});

test("a start hands off before it reports health, opens ports or creates a window, and leaves with exit 0", () => {
  const start = slice("async function start()", "\nvoid start().catch(");
  const order = [
    "const gotLock = LAUNCHED_BY_AGENT ? app.requestSingleInstanceLock({ show: false }) : app.requestSingleInstanceLock();",
    "const launch = prepareLauncherSupervision({ logger, stateStore });",
    "if (launch.exit) {",
    'reportLauncherStartup("starting");',
    "await waitForPackagedRuntimeSource",
    "cdpPort = await findFreePort();",
    "await app.whenReady();",
    "mainWindow = createWindow({",
  ].map(text => [text, start.indexOf(text)]);
  for (const [text, position] of order) assert.ok(position >= 0, text);
  for (let index = 1; index < order.length; index += 1) {
    assert.ok(order[index - 1][1] < order[index][1], `${order[index - 1][0]} comes before ${order[index][0]}`);
  }
  const exit = start.slice(start.indexOf("if (launch.exit) {"), start.indexOf('reportLauncherStartup("starting");'));
  assert.match(exit, /app\.quit\(\);\s*return;/);
  assert.doesNotMatch(exit, /app\.exit\(/);
  // The supervised launcher starts hidden unless the start it took over asked for the window.
  assert.match(start, /const startHidden = \(launchMode === "supervised"\s*\? !launch\.showRequested/);
  assert.match(start, /activateOnShow: launch\.showRequested === true/);
});

test("a launchd start never asks a running launcher to show its window; a user's second launch does", () => {
  const handlers = {};
  const shows = [];
  const context = { app: { on: (name, handler) => { handlers[name] = handler; } }, showMainWindow: () => shows.push("show") };
  vm.createContext(context);
  vm.runInContext(slice('app.on("second-instance"', "\n\n  await waitForPackagedRuntimeSource"), context);
  handlers["second-instance"]({}, [], "/", { show: false });
  assert.deepEqual(shows, []);
  handlers["second-instance"]({}, [], "/", undefined);
  handlers["second-instance"]({}, [], "/", { show: true });
  handlers.activate();
  assert.deepEqual(shows, ["show", "show", "show"]);
});

function supervisionHarness({ argv = [], platform = "darwin", packaged = true, devProfile = false, sameProfile = true, autoStart = true, launchedByAgent = false } = {}) {
  const calls = { created: [], prepared: [], logs: [], lock: [] };
  const profile = { kind: "production", coreHome: "/h/.codex-chatgpt-web", codexHome: "/h/.codex", userData: "/h/Library/Application Support/Codex Web GPT" };
  const context = {
    process: { argv: ["/Applications/Codex Web GPT.app/Contents/MacOS/Codex Web GPT", ...argv], platform, execPath: "/Applications/Codex Web GPT.app/Contents/MacOS/Codex Web GPT", getuid: () => 501 },
    app: {
      isPackaged: packaged,
      getPath: () => "/h/Library/Application Support",
      requestSingleInstanceLock: data => { calls.lock.push(["request", data]); return true; },
      releaseSingleInstanceLock: () => calls.lock.push(["release"]),
    },
    os: { homedir: () => "/h" },
    IS_DEV_PROFILE: devProfile,
    LAUNCHER_PROFILE: profile,
    LAUNCHED_BY_AGENT: launchedByAgent,
    LAUNCH_AGENT_LABEL: launchAgentModule.LAUNCH_AGENT_LABEL,
    launcherUserData: profile.userData,
    launchAgent: null,
    launchMode: "in-process",
    resolveLauncherProfile: () => (sameProfile ? { ...profile } : { ...profile, codexHome: "/h/.codex" + "-default" }),
    sameLauncherProfile: launchAgentModule.sameLauncherProfile,
    launchAgentEligibility: launchAgentModule.launchAgentEligibility,
    launchAgentPlistPath: launchAgentModule.launchAgentPlistPath,
    openedAtLoginOnMac: () => false,
    systemLaunchAgentDependencies: options => ({ fake: true, options }),
    createLaunchAgent: options => { calls.created.push(options); return { fakeAgent: true }; },
    prepareLaunch: options => {
      calls.prepared.push(options);
      options.lock.release();
      options.lock.request({ show: options.show });
      return { mode: "hand-off", exit: true, showRequested: false, code: null };
    },
  };
  vm.createContext(context);
  vm.runInContext(`${slice("function requestedHiddenStart()", "function registerIpc(")}\nglobalThis.prepare = prepareLauncherSupervision;`, context);
  const logger = { info: (event, detail) => calls.logs.push([event, detail]), warn: (event, detail) => calls.logs.push([event, detail]) };
  const result = context.prepare({ logger, stateStore: { read: () => ({ autoStart }) } });
  return { calls, result, context };
}

test("main wires the agent: default production profile only, Start at login decides, a hidden start stays hidden", () => {
  const opened = supervisionHarness();
  assert.equal(opened.calls.created.length, 1);
  assert.equal(opened.calls.created[0].label, "com.codex-superpower.launcher");
  assert.equal(opened.calls.created[0].plistPath, "/h/Library/LaunchAgents/com.codex-superpower.launcher.plist");
  assert.equal(opened.calls.created[0].uid, 501);
  const [prepared] = opened.calls.prepared;
  assert.equal(prepared.agentWanted, true);
  assert.equal(prepared.show, true);
  assert.equal(prepared.launchedByAgent, false);
  assert.deepEqual(opened.calls.lock, [["release"], ["request", { show: true }]], "the lock maps to Electron's single-instance lock");
  assert.equal(opened.context.launchMode, "hand-off");

  assert.equal(supervisionHarness({ argv: ["--hidden"] }).calls.prepared[0].show, false);
  assert.equal(supervisionHarness({ autoStart: false }).calls.prepared[0].agentWanted, false);
  assert.equal(supervisionHarness({ launchedByAgent: true }).calls.prepared[0].launchedByAgent, true);

  for (const [options, reason] of [
    [{ argv: ["--launcher-smoke-test"] }, null],
    [{ devProfile: true }, "development-profile"],
    [{ sameProfile: false }, "custom-profile"],
    [{ packaged: false }, null],
    [{ platform: "linux" }, null],
  ]) {
    const skipped = supervisionHarness(options);
    assert.deepEqual(skipped.calls.created, [], JSON.stringify(options));
    assert.deepEqual(skipped.calls.prepared, [], JSON.stringify(options));
    assert.equal(skipped.result.exit, false);
    assert.deepEqual(skipped.calls.logs.map(entry => entry[1].reason), reason ? [reason] : [], JSON.stringify(options));
  }
});

test("Start at login on macOS goes to the agent and reports whether it took effect", () => {
  const calls = [];
  const run = ({ platform, launchAgent, launchMode = "in-process", result }) => {
    const context = {
      process: { platform },
      app: { name: "app" },
      launchAgent,
      launchMode,
      setAutostart: (_app, enabled) => { calls.push(["login-item", enabled]); return { supported: true, enabled }; },
      setLaunchAgentAutostart: options => { calls.push(["agent", options.enabled, options.supervised]); return result; },
      macLoginItem: () => "login-item",
      requireAutostartState,
    };
    vm.createContext(context);
    vm.runInContext(`${slice("function applyAutostart(", "function requestedHiddenStart()")}\nglobalThis.apply = applyAutostart;`, context);
    return enabled => plain(context.apply(enabled, { info() {}, warn() {} }));
  };
  assert.deepEqual(run({ platform: "win32", launchAgent: null })(true), { supported: true, enabled: true });
  // A macOS launcher that manages no agent (another profile) keeps the login item of earlier builds.
  assert.deepEqual(run({ platform: "darwin", launchAgent: null })(false), { supported: true, enabled: false });
  assert.deepEqual(run({ platform: "darwin", launchAgent: {}, launchMode: "supervised", result: { supported: true, enabled: false } })(false), { supported: true, enabled: false });
  assert.throws(() => run({ platform: "darwin", launchAgent: {}, result: { supported: true, enabled: false } })(true), /did not enable launcher autostart/);
  assert.deepEqual(calls, [["login-item", true], ["login-item", false], ["agent", false, true], ["agent", true, false]]);
  // Startup: the agent reconciles the login item; without one the earlier reconciliation runs.
  const startup = slice("async function start()", "\nvoid start().catch(");
  assert.match(startup, /if \(launchAgent\) \{\s*\/\/ The LaunchAgent replaces the login item[\s\S]*?reconcileLoginItem\(\{[\s\S]*?\} else \{\s*const autostart = IS_DEV_PROFILE/);
});
