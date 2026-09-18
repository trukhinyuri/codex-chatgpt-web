# Roadmap and current state

Updated with every release. It lists where the product still falls short of [requirements.md](requirements.md) and what is being done about it. Detailed plans are in [plans/](plans/).

## Released

| Release | Commit | What changed for users |
| --- | --- | --- |
| R9 | `10a30a6b` | The update button explains what a pending update waits for and installs it 30 s after Codex's tasks; network failures, new advisories and a test that fails once under load no longer block updates. |
| R10 | `b158e12e` | CLIProxyAPI is part of the repository and the app; the Go toolchain and the Antigravity OAuth client are fetched at build time, pinned by SHA-256, so the repository holds no secrets and needs no local Go. |
| R11 | `38dcd221` | A failing installation receives its fix in the first quiet minute; update builds run in a private home and cannot touch user state; one invalid proxy model can no longer empty Codex's model list; the catalog stays within the 100 rows Codex Desktop reads. First release checked by CI on macOS. |
| R13 | `9c9eb015` | ChatGPT Web reliability, wave 1 ([plan](plans/2026-09-18-bridge-reliability.md), [work items](plans/2026-09-18-bridge-reliability-wave1.md)): a bridge-terminal failure now reaches Codex with a code it will not retry, instead of being read back as "at capacity"; Send no longer carries its own 15 s timeout and Stop is never pressed on a prompt ChatGPT already accepted but whose Send press failed or was unconfirmed; diagnostics keep a bounded, less noisy trace history and the model catalog survives a ChatGPT outage by serving the last-good rows instead of emptying Codex's picker; ChatGPT rate-limit cooldown is now account-wide with a single probe turn and a FIFO queue instead of every parallel turn re-escalating it, and heavy browser phases (loading a page, staged Bigger Context sends) queue on one lock per account instead of failing with "at most 5 browser pages"; the launcher proves the ChatGPT connector is paired and that ChatGPT has actually reached the tunnel before a turn sends, with a waiting ladder and a live MCP checklist instead of a 30 s personalization timeout. |

## In progress

Every branch named here is on GitHub. To continue one without earlier conversation: read its plan, check out the branch, run the full suites with an isolated short HOME/TMPDIR, finish what its plan or open pull request lists, then integrate and release by [engineering-process.md](engineering-process.md#releasing).

1. **Visible rename to Codex Superpower** with authors and About panel. Branch `fork/rename-visible` holds the first version, which the legacy-updater contract test shows is compatible with the updater at `86f2d311`. Review fixes merged with R11 go to `fork/rename-visible-r2`. [Analysis](plans/2026-09-18-rename.md).
2. **Dock, start at login, restart after a crash** through a LaunchAgent with KeepAlive, with the menu-bar icon optional. The implementation in `fork/dock-autostart-keepalive` is tested only with fakes. A real-launchd end-to-end test in CI is being built in `fork/dock-lifecycle-e2e`; do not release the lifecycle change before that test is green.
3. **Watch automation:** a daily workflow opens `auto-watch` issues for new Codex versions, upstream changes and active forks, plus a weekly technology watch. Branch `fork/watch-automation`.
4. **Failure-mode review for thousands of users** and the **multi-account design** (requirement R9). Their plans land in `docs/plans/failure-modes.md` and `docs/plans/multi-account.md`.
5. **Consent text for problem reports** (the issue appears under the user's GitHub account), branch `fork/report-disclosure`; **Windows CI**, branch `fork/windows-ci-tests` (pull request #1); **these documents**, branch `fork/requirements-docs` (pull request #2).
6. **Windows tunnel-lifecycle test fixture uses a POSIX broker-socket path.** `launcher/tests/tunnel-connector.test.cjs` (landed with R13) builds its runtime config with a filesystem `brokerSocketPath`, which `RuntimeSupervisor.validateConfig` correctly rejects on Windows as an invalid broker pipe; give the fixture a `\\.\pipe\...`-style path on Windows so the tunnel-lifecycle behaviour it tests (readiness, restart-on-config-change, supervising after a failed stop) is exercised on every platform. Windows CI is red on this PR's tests for that reason alone; do not weaken the assertions to hide it.


## Next

- **Anonymous problem reports.** Today a report is opened through the user's own GitHub CLI login, so the public issue shows the user's GitHub account, and users without `gh` cannot report at all. Send reports through a small relay that files them under the project's own identity, with the same closed allowlists, rate limits and deduplication; ask for consent once at setup. Until the relay exists, the consent dialog says plainly that the issue appears under the user's GitHub account.
- **Autonomous maintainer runs.** The work queue fills itself (problem reports, the daily watch), but an agent works through it only when someone says "continue". Run the [agent playbook](agent-playbook.md) on a schedule in CI with a model API key stored as a repository secret: it fixes, opens pull requests, and merges only what passes every check, released through staged rollout with the kill switch. Default until a key is provided: off; maintainers' own agents run the playbook.
- **Staged rollout and a kill switch** (practice gap): every installation now takes a new `main` within about an hour, so one bad release reaches everyone at once. Give each installation a stable random bucket, widen the eligible share with the age of the commit, halt a release through a file in the repository, and halt automatically when problem reports for the new commit rise.
- **Several ChatGPT accounts** (requirement R9): a browser profile and connector per account, an account pool in the bridge that schedules turns by load and per-account limits, account-sticky continuations, and setup of additional accounts from the launcher. Design in progress (`plans/multi-account.md`).
- ChatGPT Web reliability, wave 2:
  - status of limits and queues in the launcher (plan 2.3);
  - restarts and updates deferred while turns are queued (2.4);
  - message size learned per account, with compaction that always fits and never truncates (section 3);
  - a busy page no longer treated as a broken one, and one long-lived browser connection (section 4);
  - error texts that never ask the user to do the product's work (5.7).
- Harness size: every Codex turn carries about 120–144k tokens of instructions and tool definitions. Measure what reaches ChatGPT Web and reduce what the bridge does not need to send.
- Rename phase 2: move the bundle to `/Applications/Codex Superpower.app` with a migration that old updaters, rollback and login items survive ([analysis](plans/2026-09-18-rename.md)).
- Model picker: proxy models appear after the native ones in Codex Desktop's scrollable list. Document it in the launcher; consider fewer, curated proxy rows.
- Offer upstream fixes to miuuyy/codex-chatgpt-web as pull requests.

## Later, in this order

1. Windows (x64, arm64) and Linux (x64, arm64) as supported platforms, then macOS on Intel: installer, updater with rollback, autostart and crash restart per platform, each proven end to end in CI on real runners.
2. Other popular agent harnesses on the same core (the bridge already speaks the Responses API; each harness needs its own catalog, error contract and configuration management).
3. Company features: central deployment and configuration, policy, audit, support tooling.

## Decisions for the owner

Each item carries the default the project follows until the owner decides otherwise; none of them blocks work.

- **Hosting for the anonymous report relay and a model API key for autonomous runs** (both cost money and hold secrets). Default: consent-based reports through the user's `gh` with a plain disclosure; autonomous runs off.

- **Private vulnerability reporting** is off in the repository settings (Settings → Code security → Private vulnerability reporting). Until it is on, the advisory link in SECURITY.md and in the issue form opens no form, and e-mail to yuri@trukhin.com is the only private channel. Turning it on is a repository setting only the owner can change.

- **Signing:** builds are ad-hoc signed, so macOS privacy permissions granted to the app are tied to one build and reset with every update. A Developer ID certificate would fix this and allow notarization. Default: stay ad-hoc signed and re-request permissions after an update.
- **Legal positioning** for companies: OpenAI's Terms of Use (16 January 2026) forbid automatically or programmatically extracting output, sharing an account with anyone else, and circumventing rate limits. The ChatGPT Web route automates chatgpt.com for the account's owner; CLIProxyAPI rotates subscription accounts and reuses the public Antigravity OAuth client. Both carry a risk of account restrictions that companies will ask about. Default: operate transparently within limits (R3.4, R7.5) and document the risk for users.
- **Account pooling across people** was requested (any number of accounts shared by many users to raise limits). It conflicts with the terms above and would expose customers to account bans; requirement R9 implements several accounts per owner and horizontal scaling without pooling across people. Default: accounts are used by their owner only.

