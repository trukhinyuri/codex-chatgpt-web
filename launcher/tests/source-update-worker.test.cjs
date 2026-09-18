const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const WORKER = path.join(__dirname, "..", "electron", "source-update-worker.cjs");
const OLD = "1".repeat(40);
const NEW = "2".repeat(40);
const macOnly = { skip: process.platform !== "darwin" && "the worker uses macOS ditto, plutil and ps" };
const roots = [];
test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function plist(commit) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CodexWebGptSourceCommit</key><string>${commit}</string></dict></plist>
`;
}

function makeApp(application, script, commit) {
  fs.mkdirSync(path.join(application, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(application, "Contents", "MacOS", "Codex Web GPT"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  if (commit) fs.writeFileSync(path.join(application, "Contents", "Info.plist"), plist(commit));
}

/**
 * A fake install: /Applications holds the old build, the staging folder the new one. The new build's
 * behaviour at startup is a shell snippet that may write the health record like the real launcher.
 */
function scenario(newStartup, { stagedCommit = NEW, healthTimeoutMs = 3_000, existingRollbacks = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cwg-worker-"));
  roots.push(root);
  const target = path.join(root, "Applications", "Codex Web GPT.app");
  const userData = path.join(root, "userData");
  const tempRoot = path.join(root, "update-temp");
  const source = path.join(tempRoot, "stage", "Codex Web GPT.app");
  const marks = path.join(root, "marks.log");
  const health = path.join(userData, "source-update-health.json");
  const record = status => `printf '{"version":1,"commit":"${NEW}","pid":%s,"status":"${status}","reason":"runtime-test","at":"now"}\\n' $$ > "${health}.tmp" && mv "${health}.tmp" "${health}"`;
  makeApp(target, `echo old >> "${marks}"`, OLD);
  makeApp(source, `echo new >> "${marks}"\n${newStartup(record)}`, stagedCommit);
  fs.mkdirSync(userData, { recursive: true });
  for (const name of existingRollbacks) {
    makeApp(path.join(userData, "rollback.noindex", name, "Codex Web GPT.app"), "true", null);
  }
  const executable = path.join(target, "Contents", "MacOS", "Codex Web GPT");
  const exited = spawnSync("/usr/bin/true");
  const job = {
    version: 1,
    parentPid: exited.pid,
    source,
    target,
    executableName: "Codex Web GPT",
    commit: NEW,
    previousCommit: OLD,
    displayVersion: "5.0.8+2222222",
    rollbackRoot: path.join(userData, "rollback.noindex"),
    rollbackKeep: 2,
    healthPath: health,
    healthTimeoutMs,
    statePath: path.join(userData, "source-update-state.json"),
    logPath: path.join(root, "logs", "source-update.log"),
    tempRoot,
    launchCommand: ["/bin/sh", executable],
  };
  const jobPath = path.join(tempRoot, "job.json");
  fs.writeFileSync(jobPath, JSON.stringify(job));
  const run = () => {
    const result = spawnSync(process.execPath, [WORKER, jobPath], { encoding: "utf8", timeout: 60_000 });
    // The relaunched app is detached; give it a moment to leave its mark.
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && !fs.readFileSync(marks, { flag: "a+", encoding: "utf8" }).trim().endsWith(result.status === 0 ? "new" : "old")) {
      spawnSync("/bin/sleep", ["0.1"]);
    }
    return result;
  };
  const read = file => fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  return {
    root, target, userData, tempRoot, job, run,
    installedScript: () => read(executable),
    marks: () => read(marks).trim().split("\n").filter(Boolean),
    state: () => JSON.parse(read(job.statePath) || "null"),
    rollbacks: () => fs.existsSync(job.rollbackRoot) ? fs.readdirSync(job.rollbackRoot).sort() : [],
    log: () => read(job.logPath),
  };
}

test("a healthy start keeps the new build and the previous one for rollback", macOnly, () => {
  const install = scenario(record => `${record("starting")}\n${record("healthy")}`);
  const result = install.run();
  assert.equal(result.status, 0, install.log());
  assert.match(install.installedScript(), /echo new/);
  assert.deepEqual(install.marks(), ["new"]);
  assert.equal(install.state().lastResult.result, "installed");
  assert.equal(install.state().lastResult.commit, NEW);
  assert.deepEqual(install.state().failedCommits, {});
  const [entry] = install.rollbacks();
  assert.match(entry, new RegExp(`^\\d{8}T\\d{6}Z-${OLD.slice(0, 12)}$`));
  const saved = path.join(install.job.rollbackRoot, entry);
  assert.match(fs.readFileSync(path.join(saved, "Codex Web GPT.app", "Contents", "MacOS", "Codex Web GPT"), "utf8"), /echo old/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(saved, "meta.json"), "utf8")).commit, OLD);
  assert.equal(fs.existsSync(install.tempRoot), false);
  assert.deepEqual(fs.readdirSync(path.dirname(install.target)), ["Codex Web GPT.app"], "no staging copies are left behind");
});

test("an unhealthy start restores the previous build and remembers the commit", macOnly, () => {
  const install = scenario(record => `${record("starting")}\n${record("unhealthy")}`);
  const result = install.run();
  assert.equal(result.status, 1);
  assert.match(install.installedScript(), /echo old/);
  assert.deepEqual(install.marks(), ["new", "old"]);
  assert.equal(install.state().lastResult.result, "rolled-back");
  assert.equal(install.state().failedCommits[NEW].stage, "startup");
  assert.match(install.state().failedCommits[NEW].reason, /startup failed \(runtime-test\)/);
  assert.deepEqual(install.rollbacks(), [], "the restored copy leaves the rollback store");
  assert.deepEqual(fs.readdirSync(path.dirname(install.target)), ["Codex Web GPT.app"]);
});

test("a launcher that exits during startup is rolled back without waiting for the timeout", macOnly, () => {
  const install = scenario(record => record("starting"), { healthTimeoutMs: 30_000 });
  const started = Date.now();
  assert.equal(install.run().status, 1);
  assert.ok(Date.now() - started < 20_000, "a crash is detected from the dead PID, not the timeout");
  assert.match(install.installedScript(), /echo old/);
  assert.match(install.state().failedCommits[NEW].reason, /exited during startup/);
});

test("a launcher that never reports is rolled back after the timeout", macOnly, () => {
  const install = scenario(() => "true", { healthTimeoutMs: 1_500 });
  assert.equal(install.run().status, 1);
  assert.match(install.installedScript(), /echo old/);
  assert.match(install.state().failedCommits[NEW].reason, /no healthy start within 2 s/);
});

test("a staged app from another commit is refused before anything is replaced", macOnly, () => {
  const install = scenario(record => record("healthy"), { stagedCommit: "3".repeat(40) });
  assert.equal(install.run().status, 1);
  assert.match(install.installedScript(), /echo old/);
  assert.deepEqual(install.marks(), ["old"], "the unchanged app is started again");
  assert.equal(install.state().lastResult.stage, "install");
  assert.match(install.state().lastResult.reason, /is 3{40}, not 2{40}/);
  assert.deepEqual(install.rollbacks(), []);
});

test("the rollback store keeps only the two newest builds", macOnly, () => {
  const install = scenario(record => record("healthy"), {
    existingRollbacks: ["20260101T000000Z-aaaaaaaaaaaa", "20260201T000000Z-bbbbbbbbbbbb", "20260301T000000Z-cccccccccccc"],
  });
  assert.equal(install.run().status, 0, install.log());
  const kept = install.rollbacks();
  assert.equal(kept.length, 2);
  assert.equal(kept[0], "20260301T000000Z-cccccccccccc");
  assert.ok(kept[1].endsWith(OLD.slice(0, 12)), "the build this update replaced is always kept");
});
