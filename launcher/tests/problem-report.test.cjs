const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  MAX_ISSUES_PER_DAY,
  REPORT_REPOSITORY,
  buildProblemReport,
  classifyUpdateFailure,
  createProblemReporter,
  decideReport,
  readReportState,
} = require("../electron/problem-report.cjs");
const { createSourceUpdateController } = require("../electron/source-update.cjs");

const COMMIT = "2".repeat(40);
const DAY = 24 * 60 * 60_000;

const tempDirs = [];
test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cwg-problem-report-"));
  tempDirs.push(dir);
  return dir;
}

test("update failures map to fixed codes; the lock of another install is not a problem", () => {
  assert.equal(classifyUpdateFailure("run all tests (bun run verify) failed: bun run verify exited with code 1"), "verify-failed");
  assert.equal(classifyUpdateFailure("install launcher dependencies failed: ..."), "launcher-dependencies-failed");
  assert.equal(classifyUpdateFailure("install dependencies failed: ..."), "dependencies-failed");
  assert.equal(classifyUpdateFailure("git fetch --quiet origin main failed: Could not resolve host: github.com"), "network");
  assert.equal(classifyUpdateFailure("startup failed (runtime-needs-setup)"), "startup-runtime-needs-setup");
  assert.equal(classifyUpdateFailure("the new launcher exited during startup"), "exited-during-startup");
  assert.equal(classifyUpdateFailure("no healthy start within 360 s"), "startup-timeout");
  assert.equal(classifyUpdateFailure("The staged application is 3333, not 2222"), "stage-failed");
  assert.equal(classifyUpdateFailure("something /Users/alice/private happened"), "other");
  assert.equal(classifyUpdateFailure("Another source update or install is running (PID 7)"), null);
});

test("nothing but validated codes and versions reaches an issue", () => {
  const leaks = [
    "/Users/alice/Projects/secret-client",
    "alice@example.com",
    "Summarize the merger terms for ACME",
    "sk-live-abc123",
    "thread 01a0b46d-3019-7de3-8afb-3f5347f21d56",
  ];
  for (const leak of leaks) {
    const report = buildProblemReport({
      kind: "update-build-failed",
      code: `verify-failed ${leak}`,
      stage: leak,
      version: `5.0.8 ${leak}`,
      commit: leak,
      platform: leak,
      arch: leak,
      osRelease: leak,
    });
    const text = `${report.title}\n${report.body}`;
    for (const fragment of leak.split(/[\s/@]+/).filter(part => part.length > 3)) {
      assert.ok(!text.includes(fragment), `"${fragment}" leaked into the report`);
    }
    assert.equal(report.fields.code, "other");
  }
  assert.throws(() => buildProblemReport({ kind: "anything-else", code: "x" }), /Unknown problem kind/);

  const clean = buildProblemReport({
    kind: "update-rolled-back", code: "startup-timeout", stage: "startup", version: "5.0.8+2222222", commit: COMMIT,
    platform: "darwin", arch: "arm64", osRelease: "27.0.0",
  });
  assert.equal(clean.title, "[auto] update-rolled-back: startup-timeout (5.0.8+2222222)");
  assert.match(clean.body, /\| commit \| `2{40}` \|/);
  assert.match(clean.body, new RegExp(`\\| fingerprint \\| \`${clean.fingerprint}\` \\|`));
  assert.match(clean.fingerprint, /^[0-9a-f]{16}$/);
  assert.equal(buildProblemReport({ kind: "update-rolled-back", code: "startup-timeout", stage: "startup", commit: COMMIT, version: "5.0.8" }).fingerprint,
    clean.fingerprint, "the fingerprint ignores the machine, so every user's occurrence lands on one issue");
});

test("consent, daily repeats and the daily cap decide what happens", () => {
  const report = buildProblemReport({ kind: "update-build-failed", code: "verify-failed", commit: COMMIT });
  const now = Date.parse("2026-09-18T12:00:00Z");
  assert.equal(decideReport({ consent: "never", reports: {} }, report, now), "skip");
  assert.equal(decideReport({ consent: "unknown", reports: {} }, report, now), "ask");
  assert.equal(decideReport({ consent: "auto", reports: {} }, report, now), "create");
  const known = { [report.fingerprint]: { issue: 5, createdAt: new Date(now - 2 * DAY).toISOString(), lastAt: new Date(now - 60_000).toISOString() } };
  assert.equal(decideReport({ consent: "auto", reports: known }, report, now), "skip");
  known[report.fingerprint].lastAt = new Date(now - DAY - 1).toISOString();
  assert.equal(decideReport({ consent: "auto", reports: known }, report, now), "comment");
  const busy = Object.fromEntries(Array.from({ length: MAX_ISSUES_PER_DAY }, (_, index) => [`fp${index}`, { issue: index + 1, createdAt: new Date(now - 60_000).toISOString() }]));
  assert.equal(decideReport({ consent: "auto", reports: busy }, report, now), "skip");
});

function fakeGh({ existing = null, labelMissing = false } = {}) {
  const calls = [];
  const gh = async (args, options = {}) => {
    calls.push({ args, input: options.input ?? null });
    if (args[0] === "issue" && args[1] === "list") return JSON.stringify(existing ? [{ number: existing }] : []);
    if (args[0] === "issue" && args[1] === "create") {
      if (labelMissing && args.includes("--label")) throw new Error("could not add label: 'auto-report' not found");
      return `https://github.com/${REPORT_REPOSITORY}/issues/42`;
    }
    if (args[0] === "issue" && args[1] === "comment") return "";
    throw new Error(`unexpected gh call ${args.join(" ")}`);
  };
  return { gh, calls };
}

test("a consented report becomes one issue, sent through gh on standard input", async () => {
  const userDataDirectory = tempDir();
  const { gh, calls } = fakeGh({ labelMissing: true });
  const asked = [];
  let now = Date.parse("2026-09-18T12:00:00Z");
  const reporter = createProblemReporter({
    userDataDirectory, gh, findGh: async () => "gh", askConsent: async report => { asked.push(report.title); return "once"; }, now: () => now,
  });
  const result = await reporter.report({ kind: "update-rolled-back", code: "startup-timeout", stage: "startup", version: "5.0.8+2222222", commit: COMMIT });
  assert.deepEqual(result, { action: "create", issue: 42 });
  assert.equal(asked.length, 1);
  const creates = calls.filter(call => call.args[1] === "create");
  assert.equal(creates.length, 2, "retried without the label");
  assert.ok(creates[0].args.includes("--body-file") && creates[0].args.includes("-"));
  assert.ok(!creates[1].args.includes("--label"));
  assert.match(creates[1].input, /startup-timeout/);
  assert.ok(creates.every(call => call.args.includes(REPORT_REPOSITORY)));
  assert.equal(readReportState(reporter.statePath).consent, "unknown", "\"this one\" does not grant future consent");
  assert.equal(readReportState(reporter.statePath).reports[Object.keys(readReportState(reporter.statePath).reports)[0]].issue, 42);

  // The same problem again the same day: nothing is asked or sent.
  const again = await reporter.report({ kind: "update-rolled-back", code: "startup-timeout", stage: "startup", version: "5.0.8+2222222", commit: COMMIT });
  assert.equal(again.action, "skip");
  assert.equal(asked.length, 1);

  // A day later the known issue gets a short comment, still without content.
  now += DAY + 1;
  const reporterAuto = createProblemReporter({ userDataDirectory, gh, findGh: async () => "gh", askConsent: async () => "auto", now: () => now });
  const later = await reporterAuto.report({ kind: "update-rolled-back", code: "startup-timeout", stage: "startup", version: "5.0.8+2222222", commit: COMMIT });
  assert.equal(later.action, "comment");
  assert.match(calls.at(-1).input, /^Seen again on 5\.0\.8\+2222222/);
});

test("an issue another user opened gets a comment instead of a duplicate", async () => {
  const { gh, calls } = fakeGh({ existing: 7 });
  const reporter = createProblemReporter({ userDataDirectory: tempDir(), gh, findGh: async () => "gh", askConsent: async () => "auto" });
  assert.deepEqual(await reporter.report({ kind: "update-build-failed", code: "verify-failed", commit: COMMIT }), { action: "comment", issue: 7 });
  assert.ok(!calls.some(call => call.args[1] === "create"));
  assert.equal(reporter.consent(), "auto");
});

test("declining, a missing gh and an invalid report send nothing", async () => {
  const declined = fakeGh();
  const never = createProblemReporter({ userDataDirectory: tempDir(), gh: declined.gh, findGh: async () => "gh", askConsent: async () => "never" });
  assert.equal((await never.report({ kind: "update-build-failed", code: "verify-failed", commit: COMMIT })).action, "skip");
  assert.equal((await never.report({ kind: "runtime-start-failed", code: "runtime-failed", commit: COMMIT })).action, "skip");
  assert.equal(declined.calls.length, 0);
  assert.equal(never.consent(), "never");

  const noGh = createProblemReporter({ userDataDirectory: tempDir(), findGh: async () => null, askConsent: async () => "auto" });
  assert.equal((await noGh.report({ kind: "update-build-failed", code: "verify-failed", commit: COMMIT })).action, "unsent");

  const invalid = createProblemReporter({ userDataDirectory: tempDir(), findGh: async () => "gh", askConsent: async () => "auto" });
  assert.equal((await invalid.report({ kind: "made-up" })).action, "invalid");
  assert.throws(() => invalid.setConsent("maybe"), /Unknown consent/);
});

test("the updater reports build failures where they happen and worker outcomes once", async () => {
  const logs = tempDir();
  const problems = [];
  const base = {
    currentVersion: "5.0.8", currentCommit: "1".repeat(40), platform: "darwin", arch: "arm64", packaged: true,
    executablePath: "/Applications/Codex Web GPT.app/Contents/MacOS/Codex Web GPT",
    runtimeExecutable: "/runtime/bun", logsDirectory: logs, userDataDirectory: logs, sourceRoot: path.join(logs, "source"),
    onProblem: problem => problems.push(problem),
  };
  const failing = createSourceUpdateController({
    ...base,
    dependencies: {
      fetchLatestCommit: async () => COMMIT, fetchComparison: async () => ({ status: "ahead" }), fetchCheckRuns: async () => ({ check_runs: [] }),
      readLoginShellPath: async () => "", acquireLock: lockPath => lockPath, releaseLock: () => {}, appendLog: () => {},
      prepareCheckout: async () => {}, run: async (_command, args) => { if (args.join(" ") === "run verify") throw new Error("exited with code 1"); },
    },
  });
  await failing.checkOnce();
  await assert.rejects(failing.beginInstall());
  assert.deepEqual(problems, [{ kind: "update-build-failed", code: "verify-failed", stage: "build", version: "5.0.8+2222222", commit: COMMIT }]);

  fs.writeFileSync(path.join(logs, "source-update-state.json"), JSON.stringify({
    version: 1, failedCommits: {}, lastResult: { commit: COMMIT, result: "rolled-back", stage: "startup", reason: "no healthy start within 360 s", at: "2026-09-18T12:00:00Z" },
  }));
  problems.length = 0;
  createSourceUpdateController(base);
  createSourceUpdateController(base);
  assert.deepEqual(problems, [{ kind: "update-rolled-back", code: "startup-timeout", stage: "startup", version: "5.0.8+2222222", commit: COMMIT }]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(logs, "source-update-state.json"), "utf8")).lastResult.reported, true);
});

test("the launcher asks before reporting, shows the exact report, and reports runtime start failures", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "electron", "main.cjs"), "utf8");
  assert.match(main, /detail: `\$\{copy\.reportDetail\}\\n\\n\$\{report\.body\}`/);
  assert.match(main, /buttons: \[copy\.reportAlways, copy\.reportOnce, copy\.reportNotNow, copy\.reportNever\]/);
  assert.match(main, /reportProblem\(\{ kind: "runtime-start-failed", code: `runtime-\$\{runtime\.status\}`, stage: "startup" \}\)/);
  assert.match(main, /app\.isPackaged && !IS_DEV_PROFILE && SOURCE_COMMIT\.test/);
  for (const language of ["en", "zh-CN", "zh-TW", "ja", "ko"]) {
    const block = main.slice(main.indexOf(`"${language}": Object.freeze({`));
    assert.match(block.slice(0, block.indexOf("}),")), /reportNever: "/, `${language} has the consent dialog copy`);
  }
});
