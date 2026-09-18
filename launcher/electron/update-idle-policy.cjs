// When a prepared update may replace the app.
//
// An update never interrupts a turn: it waits until Codex has no active turn for a quiet period.
// The unattended period is long (ten minutes) so that a busy user is not disturbed. That rule alone
// cannot deliver a fix to a build that is failing: failed turns and Codex's retries keep arriving,
// every one of them resets the ten minutes, and the fix waits for as long as the failures last.
// When nothing succeeds there is no work to protect, so a short quiet period is enough; the same
// applies once an update has waited for hours.

const FAILING_WINDOW_MS = 15 * 60_000;
const FAILING_MIN_ENDED_TURNS = 3;
const SHORT_QUIET_MS = 60_000;
const LONG_WAIT_MS = 6 * 60 * 60_000;
const OUTCOME_LIMIT = 500;
const OUTCOMES = new Set(["completed", "failed", "aborted"]);

/** Recent outcomes of ChatGPT Web turns, as the runtime reports them to the launcher. */
function createTurnOutcomeLog({ now = Date.now, limit = OUTCOME_LIMIT } = {}) {
  const entries = [];
  return {
    record(status) {
      if (!OUTCOMES.has(status)) return;
      entries.push({ at: now(), status });
      if (entries.length > limit) entries.splice(0, entries.length - limit);
    },
    since(at) {
      return entries.filter(entry => entry.at >= at);
    },
  };
}

/**
 * The quiet period required now: `baseQuietMs` normally; at most one minute while the installed
 * build is failing (several turns ended in the last fifteen minutes and none completed) or after
 * the update has waited for six hours.
 */
function updateQuietWindow({ baseQuietMs, outcomes, waitingSince, now }) {
  const recent = outcomes.since(now - FAILING_WINDOW_MS);
  const completed = recent.some(entry => entry.status === "completed");
  if (!completed && recent.length >= FAILING_MIN_ENDED_TURNS) {
    return { quietMs: Math.min(baseQuietMs, SHORT_QUIET_MS), reason: "failing" };
  }
  if (now - waitingSince >= LONG_WAIT_MS) {
    return { quietMs: Math.min(baseQuietMs, SHORT_QUIET_MS), reason: "long-wait" };
  }
  return { quietMs: baseQuietMs, reason: "idle" };
}

module.exports = {
  FAILING_MIN_ENDED_TURNS,
  FAILING_WINDOW_MS,
  LONG_WAIT_MS,
  SHORT_QUIET_MS,
  createTurnOutcomeLog,
  updateQuietWindow,
};
