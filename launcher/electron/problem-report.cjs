const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

// Problems reach the maintainer as GitHub issues, built only from fixed codes and version numbers.
// A report never carries free text from an error, a path, a prompt, an account or a session.
const REPORT_REPOSITORY = "trukhinyuri/codex-superpower";
const REPORT_LABEL = "auto-report";
const REPORT_STATE_FILE = "problem-reports.json";
const MAX_ISSUES_PER_DAY = 5;
const REPEAT_COMMENT_INTERVAL_MS = 24 * 60 * 60_000;

const KINDS = Object.freeze({
  "update-build-failed": "An update could not be built or did not pass its tests",
  "update-install-failed": "A built update could not be installed",
  "update-rolled-back": "An installed update did not start cleanly and was rolled back",
  "runtime-start-failed": "The local runtime did not start",
});

// Every code and stage is a member of a closed list: a lowercase token that merely looks like a
// code (an API key such as "sk-live-…", a project name) can never pass.
const RUNTIME_STATUSES = ["external", "failed", "needs-setup", "stopped", "unknown"];
const CODES = new Set([
  "verify-failed", "launcher-dependencies-failed", "dependencies-failed", "package-failed",
  "commit-mismatch", "package-missing", "checkout-foreign", "network", "git-failed", "extract-failed",
  "startup-runtime-error", "startup-launcher-error", "exited-during-startup", "startup-timeout",
  "stage-failed", "runtime-start-error", "other",
  ...RUNTIME_STATUSES.map(status => `runtime-${status}`),
  ...RUNTIME_STATUSES.map(status => `startup-runtime-${status}`),
]);
const STAGES = new Set(["build", "install", "startup", "rollback"]);
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:\+[0-9a-f]{7})?$/;
const COMMIT = /^[0-9a-f]{40}$/;
const OS_RELEASE = /^\d{1,3}(?:\.\d{1,3}){0,2}$/;

/**
 * Map an update failure's message to a fixed code; the message itself is never reported. Returns
 * null for outcomes that are not problems (another install holding the build lock).
 */
function classifyUpdateFailure(message) {
  const text = String(message || "");
  if (/Another source update or install is running/.test(text)) return null;
  const rules = [
    [/run all tests \(bun run verify\) failed/, "verify-failed"],
    [/install launcher dependencies failed/, "launcher-dependencies-failed"],
    [/install dependencies failed/, "dependencies-failed"],
    [/package the app failed/, "package-failed"],
    [/was built from/, "commit-mismatch"],
    [/fresh macOS .* package/, "package-missing"],
    [/is not a Git checkout|tracks .*, not/, "checkout-foreign"],
    [/git (clone|fetch)[^:]*failed|Could not resolve host|timed out|ENOTFOUND|ECONNRESET/, "network"],
    [/git [a-z-]+ .*failed/, "git-failed"],
    [/Could not extract the built package/, "extract-failed"],
    [/startup failed \(runtime-start-error\)/, "startup-runtime-error"],
    [/startup failed \(runtime-([a-z-]+)\)/, match => `startup-runtime-${match[1]}`],
    [/startup failed \(launcher-start-error\)/, "startup-launcher-error"],
    [/exited during startup/, "exited-during-startup"],
    [/no healthy start within/, "startup-timeout"],
    [/Could not stage the new application|The staged application is/, "stage-failed"],
  ];
  for (const [pattern, code] of rules) {
    const match = pattern.exec(text);
    if (match) {
      const value = typeof code === "function" ? code(match) : code;
      return CODES.has(value) ? value : "other";
    }
  }
  return "other";
}

function field(value, pattern) {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

function member(value, allowed) {
  return typeof value === "string" && allowed.has(value) ? value : null;
}

/**
 * Title, body and fingerprint of one problem. Every value must match its pattern or is left out,
 * so nothing a caller passes by mistake (a path, an e-mail, an error text) can reach the issue.
 */
function buildProblemReport({ kind, code, stage = null, version, commit, platform = process.platform, arch = process.arch, osRelease = os.release() }) {
  if (!Object.hasOwn(KINDS, kind)) throw new Error(`Unknown problem kind: ${kind}`);
  const fields = {
    kind,
    code: member(code, CODES) ?? "other",
    stage: member(stage, STAGES),
    version: field(version, VERSION),
    commit: field(commit, COMMIT),
    platform: ["darwin", "linux", "win32"].includes(platform) ? platform : null,
    arch: ["arm64", "x64"].includes(arch) ? arch : null,
    osRelease: field(osRelease, OS_RELEASE),
  };
  const fingerprint = crypto.createHash("sha256")
    .update([fields.kind, fields.code, fields.stage, fields.commit].join("|"))
    .digest("hex")
    .slice(0, 16);
  const rows = Object.entries({ ...fields, fingerprint })
    .filter(([, value]) => value !== null)
    .map(([name, value]) => `| ${name} | \`${value}\` |`);
  const body = [
    `${KINDS[kind]}.`,
    "",
    "| Field | Value |",
    "| --- | --- |",
    ...rows,
    "",
    "Reported automatically by Codex Superpower with the user's consent. The report contains only the fields above:",
    "no prompts, session content, file paths, account data or error text.",
    "",
  ].join("\n");
  const title = `[auto] ${kind}: ${fields.code}${fields.version ? ` (${fields.version})` : ""}`;
  return { title, body, fingerprint, fields };
}

function emptyState() {
  return { version: 1, consent: "unknown", reports: {} };
}

function readReportState(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (parsed?.version === 1 && parsed.reports && typeof parsed.reports === "object"
      && ["unknown", "auto", "never"].includes(parsed.consent)) return parsed;
  } catch {}
  return emptyState();
}

function writeReportState(filePath, state) {
  writePrivateFileAtomic(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * What to do with a report: "create" a new issue, "comment" on the known one (at most daily),
 * "ask" for consent first, or "skip" (declined, already reported today, or the daily cap).
 */
function decideReport(state, report, now = Date.now()) {
  if (state.consent === "never") return "skip";
  const known = state.reports[report.fingerprint];
  if (known?.issue) {
    return now - Date.parse(known.lastAt || 0) >= REPEAT_COMMENT_INTERVAL_MS ? "comment" : "skip";
  }
  const createdToday = Object.values(state.reports)
    .filter(entry => entry?.issue && now - Date.parse(entry.createdAt || 0) < 24 * 60 * 60_000).length;
  if (createdToday >= MAX_ISSUES_PER_DAY) return "skip";
  return state.consent === "auto" ? "create" : "ask";
}

/** Run gh with a fixed argument list; the body goes through standard input, never argv. */
function runGh(ghPath, args, { input = null, env = process.env, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ghPath, args, { env, stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", chunk => out.push(chunk));
    child.stderr.on("data", chunk => err.push(chunk));
    if (input !== null) child.stdin.end(input);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out).toString("utf8").trim());
      else reject(new Error(`gh ${args[0]} ${args[1] || ""} exited with ${code}: ${Buffer.concat(err).toString("utf8").trim().slice(0, 300)}`));
    });
  });
}

async function findOpenIssue(gh, fingerprint) {
  const output = await gh(["issue", "list", "-R", REPORT_REPOSITORY, "--state", "open", "--search",
    `${fingerprint} in:body`, "--json", "number", "--limit", "1"]);
  const [issue] = JSON.parse(output || "[]");
  return Number.isInteger(issue?.number) ? issue.number : null;
}

async function createIssue(gh, report) {
  const withLabel = ["issue", "create", "-R", REPORT_REPOSITORY, "--title", report.title, "--body-file", "-", "--label", REPORT_LABEL];
  let url;
  try {
    url = await gh(withLabel, { input: report.body });
  } catch {
    // The label may not exist in a fork of the repository; the issue matters more than the label.
    url = await gh(withLabel.slice(0, -2), { input: report.body });
  }
  const match = /\/issues\/(\d+)\s*$/.exec(url);
  if (!match) throw new Error("gh did not return an issue URL");
  return Number.parseInt(match[1], 10);
}

/**
 * Report problems as issues through the user's own GitHub CLI login. `askConsent` returns
 * "auto", "once" or "never"; `findGh` returns the gh executable or null.
 */
function createProblemReporter({ userDataDirectory, findGh, askConsent, logger, now = () => Date.now(), gh: ghOverride }) {
  const statePath = path.join(userDataDirectory, REPORT_STATE_FILE);
  let queue = Promise.resolve();

  async function send(report) {
    const state = readReportState(statePath);
    let action = decideReport(state, report, now());
    if (action === "ask") {
      const answer = await askConsent(report);
      if (answer === "never" || answer === "auto") {
        state.consent = answer;
        writeReportState(statePath, state);
      }
      action = answer === "never" ? "skip" : answer === "auto" || answer === "once" ? "create" : "skip";
    }
    if (action === "skip") return { action };
    const ghPath = ghOverride ? "gh" : await findGh();
    if (!ghPath) {
      logger?.info("launcher.problem_report_unsent", { kind: report.fields.kind, code: report.fields.code, reason: "gh-unavailable" });
      return { action: "unsent" };
    }
    const gh = ghOverride ?? ((args, options) => runGh(ghPath, args, options));
    const at = new Date(now()).toISOString();
    try {
      // Another installation may already have opened the issue; add this occurrence to it.
      let issue = state.reports[report.fingerprint]?.issue ?? await findOpenIssue(gh, report.fingerprint);
      let result = "comment";
      if (issue) {
        await gh(["issue", "comment", String(issue), "-R", REPORT_REPOSITORY, "--body-file", "-"], {
          input: `Seen again${report.fields.version ? ` on ${report.fields.version}` : ""}${report.fields.osRelease ? ` (Darwin ${report.fields.osRelease})` : ""}.`,
        });
      } else {
        issue = await createIssue(gh, report);
        result = "create";
      }
      const previous = state.reports[report.fingerprint];
      state.reports[report.fingerprint] = { issue, createdAt: previous?.createdAt ?? at, lastAt: at };
      writeReportState(statePath, state);
      logger?.info("launcher.problem_reported", { kind: report.fields.kind, code: report.fields.code, issue });
      return { action: result, issue };
    } catch (error) {
      logger?.warn("launcher.problem_report_failed", { kind: report.fields.kind, code: report.fields.code, message: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
      return { action: "failed" };
    }
  }

  return {
    statePath,
    /** Reports are serialized so two problems never ask for consent at once. */
    report(input) {
      let report;
      try {
        report = buildProblemReport(input);
      } catch (error) {
        logger?.warn("launcher.problem_report_invalid", { message: error instanceof Error ? error.message : String(error) });
        return Promise.resolve({ action: "invalid" });
      }
      const result = queue.then(() => send(report));
      queue = result.catch(() => {});
      return result;
    },
    consent: () => readReportState(statePath).consent,
    setConsent(consent) {
      if (!["unknown", "auto", "never"].includes(consent)) throw new Error("Unknown consent value");
      const state = readReportState(statePath);
      state.consent = consent;
      writeReportState(statePath, state);
      return consent;
    },
  };
}

module.exports = {
  KINDS,
  MAX_ISSUES_PER_DAY,
  REPORT_LABEL,
  REPORT_REPOSITORY,
  buildProblemReport,
  classifyUpdateFailure,
  createProblemReporter,
  decideReport,
  readReportState,
};
