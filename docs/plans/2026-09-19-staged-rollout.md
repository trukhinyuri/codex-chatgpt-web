# Staged rollout and a kill switch for updates

**Requirements:** R4.1–R4.5 (an update installs only after a green build), R4.6 (the first install is
the only manual step), R4.3 in particular (a transient failure never blocks updates), R1.2 (nothing
needs maintenance), R7.5/the privacy rule behind R7 (the bucket is a local number, not an identity).

**Status:** implemented on branch `fork/staged-rollout`. Old updaters keep installing immediately by
contract; the staged rollout begins protecting an installation only once it runs a build with this
change, which is the intended and unavoidable seam of the design.

## 1. What happens today

Every installation checks `main` once an hour (`SOURCE_CHECK_INTERVAL_MS`), and a commit whose macOS
CI passed installs unattended as soon as Codex is idle. One bad release therefore reaches the whole
fleet inside about an hour, and the only brake is reverting on GitHub and waiting for the machines
to heal themselves — the rollback the worker performs after an unhealthy start.

## 2. The design

Three pieces:

1. **A stable bucket per installation.** The first check that needs it picks
   `crypto.randomInt(0, 100)` and stores it as `bucket` in `source-update-state.json`. It is a local
   number that says when this machine's turn is — not an identity, not sent anywhere, not derived
   from any account or hardware fact. Every writer of that file (the controller's failed-commit
   memory, the worker's `recordResult`, the legacy 86f2d311 updater's identical writes) spreads the
   state object, so the bucket survives all of them; the format contract test stays green.
2. **A policy file in the repository root: [`update-rollout.json`](../../update-rollout.json).**
   Every check fetches it through the GitHub contents API
   (`GET /repos/trukhinyuri/codex-superpower/contents/update-rollout.json?ref=main`, the same
   `requestJson` and 60 s timeout as the other three GitHub calls):
   ```json
   {
     "haltAll": false,
     "haltedCommits": ["<full sha>", "…"],
     "stages": [
       { "ageHours": 0, "percent": 10 },
       { "ageHours": 6, "percent": 50 },
       { "ageHours": 24, "percent": 100 }
     ]
   }
   ```
   The installation's share is the largest `percent` among stages whose `ageHours` is at most the
   commit's age (age = now − `commit.committer.date` from `commits/main`, floored at zero); the
   update installs by itself when `bucket < share`. Stages may be listed in any order.
3. **The kill switch.** `haltAll: true`, or the target commit's full sha in `haltedCommits`, sets
   `automatic: false, blocked: "rollout-halted"` on every installation that reads the file — within
   one check interval. To stop a release: edit `update-rollout.json` on `main` (a one-line commit);
   nothing else. A bucket outside the current stage yields `blocked: "rollout-staging"`.

Both rollout blockers behave exactly like the existing ones (`ci-pending`, `failed-before`,
`history-*`): they gate only the *unattended* install. The update button keeps showing "Update to
v…" and a click still installs the commit by hand — that is how `failed-before` already works, and
`blocked` reasons have never carried UI text of their own (verified: the renderer never reads the
`blocked` field; `launcher/src/update-button.ts` renders only the pending-install states).

## 3. Failure behaviour (R4.3)

| Situation | Result |
| --- | --- |
| File missing (404), network error, timeout | Built-in default policy `10% / 6h→50% / 24h→100%` is used; the check itself succeeds; the fallback and its reason are recorded in `source-update-state.json` as `lastRolloutPolicy` (`{ source: "default", reason, at }`) and logged |
| File present but not valid JSON, or wrong shape (empty `stages`, `percent` outside 0–100, non-string `haltedCommits`, …) | Same: default policy, reason `update-rollout.json is not a valid rollout policy`. A damaged policy is rejected whole, never repaired, so a broken edit cannot widen the rollout by accident |
| `commits/main` payload without a usable committer date | Staging is skipped for that check (never a permanent block: the next hourly check gets a good payload); a halt still applies |
| `haltAll` or `haltedCommits` | Applies whatever the age and bucket are — the kill switch outranks staging |

The default-on-failure choice is deliberate: when the policy channel is unavailable, installations
keep the *staged* behaviour rather than freezing (fail-open for the check, conservative for the
share). Deleting the file is **not** the way to disable staging — `haltAll: true` is; a missing file
means "use the default stages", per this table.

## 4. Evidence

- `launcher/electron/source-update.cjs`: `ensureRolloutBucket`, `normalizeRolloutPolicy`,
  `rolloutShare`, `rolloutUpdateBlocker`, `parseRolloutPolicyFile`, `noteRolloutPolicySource`, and
  the rollout gate in `checkOnce` (evaluated only after the existing safety blockers pass, so a
  safety reason keeps its place in the log).
- `launcher/tests/source-update.test.cjs` (52 tests, was 43): the bucket is picked once, kept across
  restarts and the failed-commit memory's rewrites, and re-rolled only when invalid; stage edges
  (buckets 9/10 at 0 h, 49/50 at 6 h, 99 at 23.9 h vs 24 h, ages 0/6/24 → 10/50/100 %); `haltAll`
  and `haltedCommits` block while a click still installs; 404/broken-file fallback to the default
  with the reason noted in the state, while a bucket-99 installation still gets a day-old commit
  (proof the default really ran); unknown commit age never stages; a future committer date counts as
  age zero.
- `bun run launcher:test` 481 tests, 0 fail — including `updater-compatibility.test.cjs` and
  `legacy-updater-contract.test.cjs` unmodified: the oldest live updater still installs, and the
  state-file format it reads and writes is unchanged (extra fields only).
- `bun test ./tests` 1024 tests, 0 fail.

## 5. How to operate it

- **Watch a release go out slowly:** do nothing; 10 % take a new commit at once, half the fleet after
  six hours, everyone after a day.
- **Slow it down / speed it up:** edit `stages` in `update-rollout.json` (percents are shares of
  installations, ages are hours since the commit landed).
- **Stop one bad commit:** add its full sha to `haltedCommits`.
- **Stop everything:** set `haltAll: true`.
- **See why an installation is waiting:** `blocked` is `rollout-staging` or `rollout-halted` in the
  published update state and the `launcher.update_available` log line (which also carries
  `rollout: { bucket, ageHours, policy }`); `source-update-state.json` holds `lastRolloutPolicy`
  when the built-in default was used and why.

## 6. Not verified

- The GitHub contents API is not exercised against the live network in tests (every fetch is
  injected, as for the other three GitHub calls); the default `fetchRolloutPolicy` path — real
  request, base64 decode — was reviewed but proven only by `parseRolloutPolicyFile`'s unit tests.
- The rollout statistics themselves (what share of real installations hold which bucket) are not
  collected anywhere; the design deliberately sends nothing back. Observing a rollout therefore
  means watching problem reports and `blocked` reasons, not a dashboard.
- Old updaters keep installing immediately until every installation has turned over; the fleet
  becomes fully staged only as builds with this change replace the older ones.
- The "automatic halt when problem reports rise" part of the roadmap item is **not** in this change;
  it needs a signal the repository can compute, and is left as the follow-up it is listed as.
