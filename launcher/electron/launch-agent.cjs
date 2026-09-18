// macOS: a per-user LaunchAgent starts the launcher at login and restarts it after a crash. Every
// start that launchd did not make (Finder, the Dock, `open`, the update worker) hands off to the
// agent, so the running launcher is always the supervised one. Every launchctl and file call goes
// through injected dependencies; only main.cjs passes the real ones.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { renameAtomicFile } = require("./atomic-file.cjs");

// The one place that names the agent. package.cjs stamps it into Info.plist for the install and
// rollback scripts, and the update worker receives it in its job.
const LAUNCH_AGENT_LABEL = "com.codex-superpower.launcher";
// launchd starts the launcher with this flag; its absence means someone else started it.
const LAUNCH_AGENT_FLAG = "--launched-by-launch-agent";
const LAUNCHCTL = "/bin/launchctl";
const THROTTLE_INTERVAL_SECONDS = 10;
// A start that hands off leaves this file in userData when the user opened the app, so the
// supervised launcher shows its window (launchd cannot pass arguments to a kickstarted job).
const SHOW_REQUEST_FILE = "launch-agent-show.json";
const SHOW_REQUEST_MAX_AGE_MS = 2 * 60_000;
// Electron's single-instance lock: a symlink in userData whose target ends with "-<pid>".
const SINGLETON_LOCK_FILE = "SingletonLock";
const HANDOFF_TIMEOUT_MS = 30_000;
const HANDOFF_POLL_MS = 200;
const HANDOFF_REKICK_MS = 5_000;
const UNLOAD_TIMEOUT_MS = 5_000;
const BOOTSTRAP_TIMEOUT_MS = 5_000;
// Exit status of a start that asks launchd for another attempt (EX_TEMPFAIL). Any non-zero status
// restarts the agent; an intentional quit exits 0 and is never restarted.
const EXIT_RESTART_BY_LAUNCHD = 75;
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/;

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * RunAtLoad starts the launcher at login. KeepAlive/SuccessfulExit=false restarts it after a crash
 * or a non-zero exit but never after an intentional quit, which exits 0. When the launcher exits,
 * launchd ends what is left in its process group (an update build or git step a crash interrupted);
 * the runtime, the tunnel and the update worker run detached in their own groups and are unaffected.
 */
function launchAgentPlist({ label = LAUNCH_AGENT_LABEL, executable }) {
  if (!LABEL_PATTERN.test(label)) throw new Error(`Invalid launch agent label: ${label}`);
  if (typeof executable !== "string" || !path.isAbsolute(executable)) {
    throw new Error("The launch agent needs the absolute path of the launcher executable");
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(executable)}</string>
    <string>${LAUNCH_AGENT_FLAG}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>${THROTTLE_INTERVAL_SECONDS}</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
</dict>
</plist>
`;
}

function launchAgentPlistPath(homeDir, label = LAUNCH_AGENT_LABEL) {
  return path.join(homeDir, "Library", "LaunchAgents", `${label}.plist`);
}

/** The .app bundle that contains this executable, or null when it does not run from one. */
function applicationBundleOf(executable) {
  if (typeof executable !== "string" || !path.isAbsolute(executable)) return null;
  const macos = path.dirname(executable);
  const contents = path.dirname(macos);
  const bundle = path.dirname(contents);
  if (path.basename(macos) !== "MacOS" || path.basename(contents) !== "Contents" || !bundle.endsWith(".app")) return null;
  return bundle;
}

function launchedByLaunchAgent(argv) {
  return Array.isArray(argv) && argv.includes(LAUNCH_AGENT_FLAG);
}

function sameLauncherProfile(left, right) {
  return Boolean(left && right)
    && left.kind === right.kind
    && ["coreHome", "codexHome", "userData"].every(key => typeof left[key] === "string"
      && typeof right[key] === "string"
      && path.resolve(left[key]) === path.resolve(right[key]));
}

/**
 * Only the installed production app of the default profile is supervised. Launchd starts it with a
 * clean environment, so a run with another profile, a DEV run, a smoke test or an unpackaged build
 * must never rewrite the user's agent. A translocated app (Gatekeeper's randomized read-only copy)
 * has a path that disappears, so it is not recorded either.
 */
function launchAgentEligibility({ platform, packaged, developmentProfile, smokeTest, defaultProfile, executable }) {
  if (platform !== "darwin") return { eligible: false, reason: "unsupported-platform" };
  if (!packaged) return { eligible: false, reason: "not-packaged" };
  if (developmentProfile) return { eligible: false, reason: "development-profile" };
  if (smokeTest) return { eligible: false, reason: "smoke-test" };
  if (!defaultProfile) return { eligible: false, reason: "custom-profile" };
  if (!applicationBundleOf(executable)) return { eligible: false, reason: "not-in-bundle" };
  if (executable.includes("/AppTranslocation/")) return { eligible: false, reason: "translocated" };
  return { eligible: true, reason: null };
}

/**
 * supervised: launchd started this process; it runs.
 * hand-off:   the agent is wanted but someone else started this process; launchd must start it.
 * in-process: no agent (not eligible or turned off, or the hand-off failed); this process runs.
 */
function decideLaunch({ eligible, launchedByAgent, agentWanted }) {
  if (!eligible) return "in-process";
  if (launchedByAgent) return "supervised";
  return agentWanted ? "hand-off" : "in-process";
}

/** `launchctl print` is text for people; anything that is not an absolute program path counts as unknown. */
function parseServiceStatus(output) {
  const text = String(output || "");
  const listed = /^\s*program = (.+)$/m.exec(text)?.[1]?.trim() || "";
  const program = path.isAbsolute(listed) ? listed : null;
  const pid = /^\s*pid = (\d+)$/m.exec(text)?.[1];
  return { program, pid: pid ? Number.parseInt(pid, 10) : null, running: /^\s*state = running$/m.test(text) };
}

/**
 * `launchctl print-disabled` lists services a user, System Settings (Login Items) or an MDM profile
 * switched off, as `"label" => disabled` (older macOS: `=> true`). launchd refuses to load them.
 */
function serviceDisabled(output, label) {
  const line = String(output || "").split("\n").find(entry => entry.includes(`"${label}"`));
  return Boolean(line) && /=>\s*(disabled|true)\b/.test(line);
}

function requireDependencies(deps) {
  for (const name of ["readFile", "writeFile", "removeFile", "launchctl", "lockHolderPid", "now", "sleep"]) {
    if (typeof deps?.[name] !== "function") throw new Error(`Launch agent dependency ${name} is missing`);
  }
  return deps;
}

function createLaunchAgent({ label = LAUNCH_AGENT_LABEL, executable, plistPath, uid, userDataDirectory, deps }) {
  requireDependencies(deps);
  if (!LABEL_PATTERN.test(label)) throw new Error(`Invalid launch agent label: ${label}`);
  if (!Number.isInteger(uid) || uid < 0) throw new Error("The launch agent needs the user id");
  if (typeof plistPath !== "string" || !path.isAbsolute(plistPath)) throw new Error("The launch agent needs an absolute plist path");
  if (typeof userDataDirectory !== "string" || !path.isAbsolute(userDataDirectory)) {
    throw new Error("The launch agent needs the absolute userData directory");
  }
  const domain = `gui/${uid}`;
  const target = `${domain}/${label}`;
  const desired = launchAgentPlist({ label, executable });
  const showRequestPath = path.join(userDataDirectory, SHOW_REQUEST_FILE);
  const run = args => {
    const result = deps.launchctl(args) || {};
    return {
      ok: result.status === 0,
      status: result.status ?? null,
      stdout: String(result.stdout || ""),
      stderr: String(result.stderr || ""),
    };
  };
  const disabled = () => {
    const result = run(["print-disabled", domain]);
    return result.ok && serviceDisabled(result.stdout, label);
  };
  const status = () => {
    const result = run(["print", target]);
    return result.ok ? { loaded: true, ...parseServiceStatus(result.stdout) } : { loaded: false, program: null, pid: null, running: false };
  };
  const waitUntil = (condition, timeoutMs) => {
    const deadline = deps.now() + timeoutMs;
    for (;;) {
      if (condition()) return true;
      if (deps.now() >= deadline) return false;
      deps.sleep(100);
    }
  };
  return {
    label,
    executable,
    plistPath,
    domain,
    target,
    desiredPlist: () => desired,
    installed: () => deps.readFile(plistPath) === desired,
    /** Write the plist when it is missing or differs (another path after a move, a new format). */
    writePlist() {
      if (deps.readFile(plistPath) === desired) return { changed: false };
      deps.writeFile(plistPath, desired, 0o644);
      if (deps.readFile(plistPath) !== desired) throw new Error("The launch agent plist did not read back");
      return { changed: true };
    },
    removePlist() {
      if (deps.readFile(plistPath) === null) return { removed: false };
      deps.removeFile(plistPath);
      return { removed: true };
    },
    status,
    /** True when macOS will not load the agent: switched off in System Settings, by MDM or launchctl. */
    disabled,
    bootstrap() {
      let result = run(["bootstrap", domain, plistPath]);
      const refused = () => /disabled/i.test(result.stderr);
      // Right after a bootout launchd may still be tearing the old job down; a disabled service
      // never loads, so it is not retried.
      if (!result.ok && !refused()) {
        waitUntil(() => (result = run(["bootstrap", domain, plistPath])).ok || refused() || status().loaded, BOOTSTRAP_TIMEOUT_MS);
      }
      return { ok: result.ok || status().loaded };
    },
    bootout() {
      run(["bootout", target]);
      return { ok: waitUntil(() => !status().loaded, UNLOAD_TIMEOUT_MS) };
    },
    kickstart: () => ({ ok: run(["kickstart", target]).ok }),
    lockHolderPid: () => deps.lockHolderPid(),
    now: () => deps.now(),
    sleep: milliseconds => deps.sleep(milliseconds),
    requestShow() {
      deps.writeFile(showRequestPath, `${JSON.stringify({ version: 1, at: new Date(deps.now()).toISOString() })}\n`, 0o600);
    },
    clearShowRequest() {
      try { deps.removeFile(showRequestPath); } catch {}
    },
    /** True once for a fresh request; the file is removed either way. */
    consumeShowRequest() {
      let text = null;
      try { text = deps.readFile(showRequestPath); } catch {}
      if (text === null) return false;
      try { deps.removeFile(showRequestPath); } catch {}
      try {
        const age = deps.now() - Date.parse(JSON.parse(text).at);
        return Number.isFinite(age) && age >= -60_000 && age <= SHOW_REQUEST_MAX_AGE_MS;
      } catch {
        return false;
      }
    },
  };
}

function noLog() {}

/**
 * Give this start to launchd: release the single-instance lock, make sure the agent is current and
 * loaded, kickstart it and wait until the supervised launcher holds the lock. Everything is
 * synchronous so the process never becomes ready (no window, no ports) before it decides to leave.
 * On any failure this start takes the lock back and keeps running; if another launcher took it in
 * the meantime, that one serves the user.
 */
function handOffToLaunchAgent({
  agent,
  lock,
  show,
  log = noLog,
  timeoutMs = HANDOFF_TIMEOUT_MS,
  pollMs = HANDOFF_POLL_MS,
  rekickMs = HANDOFF_REKICK_MS,
}) {
  if (show) {
    try { agent.requestShow(); } catch { log("warn", "launch_agent.show_request_failed", { code: "show-request-write-failed" }); }
  }
  lock.release();
  const fail = code => {
    if (show) agent.clearShowRequest();
    log("warn", "launch_agent.handoff_failed", { code });
    // Taking the lock back fails only if another launcher holds it; that one then shows its window
    // only for a start the user asked to see.
    if (lock.request({ show: Boolean(show) })) return { outcome: "in-process", code };
    log("info", "launch_agent.handoff_superseded", { code });
    return { outcome: "running-elsewhere", code };
  };
  try {
    let changed = false;
    try {
      changed = agent.writePlist().changed;
    } catch {
      return fail("plist-write-failed");
    }
    let status = agent.status();
    const stale = status.loaded && (changed || (status.program !== null && status.program !== agent.executable));
    if (stale && !agent.bootout().ok) log("warn", "launch_agent.reload_failed", { code: "bootout-failed" });
    if (stale) status = agent.status();
    let bootstrapped = false;
    if (!status.loaded) {
      // Switched off in System Settings or by MDM: that is the user's or the admin's decision.
      if (agent.disabled()) return fail("agent-disabled");
      if (!agent.bootstrap().ok) return fail(agent.disabled() ? "agent-disabled" : "bootstrap-failed");
      bootstrapped = true;
    }
    // RunAtLoad already started a freshly bootstrapped job; kickstart covers a loaded, idle one.
    if (!agent.kickstart().ok && !bootstrapped) return fail("kickstart-failed");
    const started = agent.now();
    let kicked = started;
    for (;;) {
      if (agent.lockHolderPid() !== null) {
        log("info", "launch_agent.handed_off", { plistChanged: changed, bootstrapped, waitedMs: agent.now() - started });
        return { outcome: "handed-off", code: null };
      }
      const now = agent.now();
      if (now - started >= timeoutMs) return fail("handoff-timeout");
      // A supervised start that lost a lock race exits 0 and is not restarted: start it again.
      if (now - kicked >= rekickMs) {
        agent.kickstart();
        kicked = now;
      }
      agent.sleep(pollMs);
    }
  } catch {
    return fail("unexpected-error");
  }
}

function refreshPlist(agent, log) {
  try {
    if (agent.writePlist().changed) log("info", "launch_agent.plist_updated", { code: "plist-rewritten" });
    return true;
  } catch {
    log("warn", "launch_agent.install_failed", { code: "plist-write-failed" });
    return false;
  }
}

/** Remove the agent. A supervised launcher never unloads its own job: that would stop it now. */
function removeAgent(agent, { unload }, log) {
  try {
    const { removed } = agent.removePlist();
    let unloaded = false;
    if (unload && agent.status().loaded) unloaded = agent.bootout().ok;
    if (removed || unloaded) log("info", "launch_agent.removed", { unloaded });
  } catch {
    log("warn", "launch_agent.remove_failed", { code: "remove-failed" });
  }
}

/** Runs before the app is ready. Never throws: a problem with the agent never stops a start. */
function prepareLaunch({ agent, eligible, launchedByAgent, agentWanted, show, lock, log = noLog, timing = {} }) {
  const mode = decideLaunch({ eligible: eligible && Boolean(agent), launchedByAgent, agentWanted });
  if (mode === "hand-off") {
    const result = handOffToLaunchAgent({ agent, lock, show, log, ...timing });
    if (result.outcome === "in-process") return { mode: "in-process", exit: false, showRequested: false, code: result.code };
    return { mode: "hand-off", exit: true, showRequested: false, code: result.code };
  }
  try {
    if (mode === "supervised") {
      const showRequested = agent.consumeShowRequest();
      if (agentWanted) refreshPlist(agent, log);
      else removeAgent(agent, { unload: false }, log);
      return { mode, exit: false, showRequested, code: null };
    }
    if (agent && !agentWanted) removeAgent(agent, { unload: true }, log);
  } catch {
    log("warn", "launch_agent.error", { code: "unexpected-error" });
  }
  return { mode, exit: false, showRequested: false, code: null };
}

/**
 * The launch agent replaces the login item of earlier builds. While the agent is installed the
 * login item is removed, so the app never starts twice at login; only when the agent's plist cannot
 * be written does the login item stay (or come back) so the app still starts at login.
 */
function reconcileLoginItem({ agent, agentWanted, loginItem, log = noLog }) {
  let installed = false;
  try { installed = agentWanted && agent.installed(); } catch {}
  const wanted = agentWanted && !installed;
  let enabled;
  try { enabled = loginItem.enabled(); } catch { return { loginItem: null }; }
  if (enabled === wanted) return { loginItem: enabled };
  try { loginItem.set(wanted); } catch {}
  let after = enabled;
  try { after = loginItem.enabled(); } catch {}
  log(after === wanted ? "info" : "warn", wanted ? "launch_agent.login_item_fallback" : "launch_agent.login_item_removed", {
    ok: after === wanted,
  });
  return { loginItem: after };
}

/** "Start at login" on macOS. Enabling writes the agent; it supervises from the next start. */
function setLaunchAgentAutostart({ agent, enabled, supervised, loginItem, log = noLog }) {
  if (enabled) refreshPlist(agent, log);
  else removeAgent(agent, { unload: !supervised }, log);
  reconcileLoginItem({ agent, agentWanted: enabled, loginItem, log });
  let launchAgent = false;
  try { launchAgent = agent.installed(); } catch {}
  let loginItemEnabled = false;
  try { loginItemEnabled = loginItem.enabled() === true; } catch {}
  return {
    supported: true,
    enabled: launchAgent || loginItemEnabled,
    launchAgent,
    blocked: enabled && launchAgent && agentBlocked(agent),
  };
}

/** The agent is installed but macOS will not run it (System Settings, MDM). Never throws. */
function agentBlocked(agent) {
  try {
    return agent.disabled() === true;
  } catch {
    return false;
  }
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(milliseconds) {
  Atomics.wait(sleepCell, 0, 0, Math.max(0, milliseconds));
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function writeFileAtomic(filePath, content, mode) {
  // ~/Library/LaunchAgents keeps its usual permissions; only a missing folder is created. The
  // temporary copy is a dotfile without the .plist suffix, so launchd never loads a partial agent.
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o755 });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(temporary, content, { flag: "wx", mode });
    fs.chmodSync(temporary, mode);
    renameAtomicFile(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** The real system: launchctl, the file system and Electron's lock. Used by main.cjs only. */
function systemLaunchAgentDependencies({ userDataDirectory, selfPid = process.pid }) {
  return {
    readFile(file) {
      try {
        return fs.readFileSync(file, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
    },
    writeFile: writeFileAtomic,
    removeFile: file => fs.rmSync(file, { force: true }),
    launchctl(args) {
      const result = spawnSync(LAUNCHCTL, args, { encoding: "utf8", timeout: 60_000 });
      return { status: result.error ? null : result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
    },
    lockHolderPid() {
      let target;
      try { target = fs.readlinkSync(path.join(userDataDirectory, SINGLETON_LOCK_FILE)); } catch { return null; }
      const pid = Number.parseInt(/-(\d+)$/.exec(target)?.[1] || "", 10);
      return Number.isInteger(pid) && pid > 0 && pid !== selfPid && processAlive(pid) ? pid : null;
    },
    now: () => Date.now(),
    sleep: sleepSync,
  };
}

module.exports = {
  EXIT_RESTART_BY_LAUNCHD,
  HANDOFF_TIMEOUT_MS,
  LAUNCH_AGENT_FLAG,
  LAUNCH_AGENT_LABEL,
  LAUNCHCTL,
  SHOW_REQUEST_FILE,
  SHOW_REQUEST_MAX_AGE_MS,
  SINGLETON_LOCK_FILE,
  THROTTLE_INTERVAL_SECONDS,
  agentBlocked,
  applicationBundleOf,
  createLaunchAgent,
  decideLaunch,
  handOffToLaunchAgent,
  launchAgentEligibility,
  launchAgentPlist,
  launchAgentPlistPath,
  launchedByLaunchAgent,
  parseServiceStatus,
  prepareLaunch,
  reconcileLoginItem,
  removeAgent,
  sameLauncherProfile,
  serviceDisabled,
  setLaunchAgentAutostart,
  systemLaunchAgentDependencies,
};
