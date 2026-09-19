# Roadmap and current state

Updated with every release. It lists where the product still falls short of [requirements.md](requirements.md) and what is being done about it. Detailed plans are in [plans/](plans/).

## Released

| Release | Commit | What changed for users |
| --- | --- | --- |
| R9 | `10a30a6b` | The update button explains what a pending update waits for and installs it 30 s after Codex's tasks; network failures, new advisories and a test that fails once under load no longer block updates. |
| R10 | `b158e12e` | CLIProxyAPI is part of the repository and the app; the Go toolchain and the Antigravity OAuth client are fetched at build time, pinned by SHA-256, so the repository holds no secrets and needs no local Go. |
| R11 | `38dcd221` | A failing installation receives its fix in the first quiet minute; update builds run in a private home and cannot touch user state; one invalid proxy model can no longer empty Codex's model list; the catalog stays within the 100 rows Codex Desktop reads. First release checked by CI on macOS. |
| R13 | `9c9eb015` | ChatGPT Web reliability, wave 1 ([plan](plans/2026-09-18-bridge-reliability.md), [work items](plans/2026-09-18-bridge-reliability-wave1.md)): a bridge-terminal failure now reaches Codex with a code it will not retry, instead of being read back as "at capacity"; Send no longer carries its own 15 s timeout and Stop is never pressed on a prompt ChatGPT already accepted but whose Send press failed or was unconfirmed; diagnostics keep a bounded, less noisy trace history and the model catalog survives a ChatGPT outage by serving the last-good rows instead of emptying Codex's picker; ChatGPT rate-limit cooldown is now account-wide with a single probe turn and a FIFO queue instead of every parallel turn re-escalating it, and heavy browser phases (loading a page, staged Bigger Context sends) queue on one lock per account instead of failing with "at most 5 browser pages"; the launcher proves the ChatGPT connector is paired and that ChatGPT has actually reached the tunnel before a turn sends, with a waiting ladder and a live MCP checklist instead of a 30 s personalization timeout. |
| R14 | `2e60f0e3` | An update is installed by a process of the app's own bundle instead of the Bun binary in the user's home, so macOS sees the application replace itself — the shape Sparkle and Squirrel.Mac use, and the one Apple's "same developer or team" exemption applies to as soon as the builds carry a Team ID ([plan](plans/2026-09-19-update-without-app-management.md)). An installation that may not replace its bundle no longer quits into a half-finished update: it keeps running with its verified build staged and reports `bundle-not-writable`, which the problem reports now tell apart from a broken build. |

## In progress

Every branch named here is on GitHub. To continue one without earlier conversation: read its plan, check out the branch, run the full suites with an isolated short HOME/TMPDIR, finish what its plan or open pull request lists, then integrate and release by [engineering-process.md](engineering-process.md#releasing).

1. **Live checks of the tunnel, the ChatGPT workspace and the connector**, branch `fork/doctor-live-checks` (pull request #9). `doctor` and a turn's pre-flight ask OpenAI whether this computer's tunnel still exists and whether its runtime key still opens it (`GET /v1/tunnels/{id}`), compare the ChatGPT workspace the embedded browser is signed in to with the tunnel's own workspaces, and read what the launcher last saw in ChatGPT's connector menu. Each failure names one action instead of "local checks cannot prove", and a turn ends at once on a proven absence (`connector_not_found:tunnel_missing`, `:tunnel_not_shared`, `:wrong_workspace`) instead of waiting about four minutes for a connector that cannot appear. It also ports upstream [#568](https://github.com/miuuyy/codex-chatgpt-web/pull/568) (a mid-turn environment delta that omits `cwd` is answered from the thread's own trusted authority) and degrades an effort level the account does not have to High instead of failing every attachment (upstream [#564](https://github.com/miuuyy/codex-chatgpt-web/issues/564)).
2. **Visible rename to Codex Superpower** with authors and About panel. Branch `fork/rename-visible` holds the first version, which the legacy-updater contract test shows is compatible with the updater at `86f2d311`. Review fixes merged with R11 go to `fork/rename-visible-r2`. [Analysis](plans/2026-09-18-rename.md).
3. **Dock, start at login, restart after a crash** through a LaunchAgent with KeepAlive, with the menu-bar icon optional. The implementation in `fork/dock-autostart-keepalive` is tested only with fakes. A real-launchd end-to-end test in CI is being built in `fork/dock-lifecycle-e2e`; do not release the lifecycle change before that test is green.
4. **Watch automation:** a daily workflow opens `auto-watch` issues for new Codex versions, upstream changes and active forks, plus a weekly technology watch. Branch `fork/watch-automation`.
5. **Failure-mode review for thousands of users** and the **multi-account design** (requirement R9). Their plans land in `docs/plans/failure-modes.md` and `docs/plans/multi-account.md`.
6. **Consent text for problem reports** (the issue appears under the user's GitHub account), branch `fork/report-disclosure`; **Windows CI**, branch `fork/windows-ci-tests` (pull request #1); **these documents**, branch `fork/requirements-docs` (pull request #2).
7. **Windows tunnel-lifecycle test fixture uses a POSIX broker-socket path.** `launcher/tests/tunnel-connector.test.cjs` (landed with R13) builds its runtime config with a filesystem `brokerSocketPath`, which `RuntimeSupervisor.validateConfig` correctly rejects on Windows as an invalid broker pipe; give the fixture a `\\.\pipe\...`-style path on Windows so the tunnel-lifecycle behaviour it tests (readiness, restart-on-config-change, supervising after a failed stop) is exercised on every platform. Windows CI is red on this PR's tests for that reason alone; do not weaken the assertions to hide it.
8. **Staged rollout and a kill switch**, branch `fork/staged-rollout`. Each installation now holds a stable random bucket (a local number in `source-update-state.json`, not an identity), and a new `main` commit reaches only the share of buckets allowed for its age by [`update-rollout.json`](../update-rollout.json) in the repository root — 10 % at once, half after six hours, everyone after a day — instead of the whole fleet within an hour. The maintainer halts a release everywhere or one commit by editing that one file (`haltAll`, `haltedCommits`); a manual click still installs regardless. Old updaters keep installing immediately until they are replaced, by contract. [Design and evidence](plans/2026-09-19-staged-rollout.md).

## Next

- **Account safety.** On 18.09 ChatGPT held the owner's account for suspicious activity after a day
  of parallel bridge traffic ([postmortem](incidents/2026-09-18-account-lock.md)). Landed in
  `fork/account-safety`: ChatGPT Web — Pro retired everywhere (Extra High is the top mode, a Pro
  thread gets one action), a security-hold detector that stops automatic turns for a held account
  until a person secures it, and an account-wide pause after any ChatGPT-side failure (60 s,
  doubling to 5 minutes). Still open: the launcher does not show a held account yet (reliability
  wave 2, plan 2.3), and recovery still needs the Codex Native connector to be created again when
  the password changed (`fork/rel-connector`).

- **Anonymous problem reports.** Today a report is opened through the user's own GitHub CLI login, so the public issue shows the user's GitHub account, and users without `gh` cannot report at all. Send reports through a small relay that files them under the project's own identity, with the same closed allowlists, rate limits and deduplication; ask for consent once at setup. Until the relay exists, the consent dialog says plainly that the issue appears under the user's GitHub account.
- **Autonomous maintainer runs.** The work queue fills itself (problem reports, the daily watch), but an agent works through it only when someone says "continue". Run the [agent playbook](agent-playbook.md) on a schedule in CI with a model API key stored as a repository secret: it fixes, opens pull requests, and merges only what passes every check, released through staged rollout with the kill switch. Default until a key is provided: off; maintainers' own agents run the playbook.
- **Several ChatGPT accounts** (requirement R9): a browser profile and connector per account, an account pool in the bridge that schedules turns by load and per-account limits, account-sticky continuations, and setup of additional accounts from the launcher. Design in progress (`plans/multi-account.md`). Upstream feature request [#563](https://github.com/miuuyy/codex-chatgpt-web/issues/563) asks for the same thing and is worth reading before the design is fixed. Until then one partition holds every signed-in ChatGPT account, ChatGPT Web switches between them, and the product only *detects* the mismatch: the workspace in use is compared with the tunnel's workspaces and a turn fails at once with `connector_not_found:wrong_workspace` instead of going to an account where no connector exists.
- **Prove the ChatGPT workspace selector.** The workspace in use is read from ChatGPT's own `_account` cookie (`launcher/electron/browser-host.cjs`). The comparison is written so that only a value shaped like a workspace id is used and only a mismatch with a tunnel whose workspaces are known ends a turn, but the cookie's name and meaning have not been confirmed against a live account with two workspaces. Confirm it on such an account, or replace the source with the connector menu, and record the result here.
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

- **Signing:** builds are ad-hoc signed, so macOS privacy permissions granted to the app are tied to one build and reset with every update, and the app has no Team ID. Apple's exemption that lets an app replace its own bundle without the "App Management" permission is keyed to the Team ID ([WWDC22 10096](https://developer.apple.com/videos/play/wwdc2022/10096/)), so without a certificate an update can be stopped by that permission request on a user's Mac — the manual step R4.6 forbids ([analysis](plans/2026-09-19-update-without-app-management.md)). A Developer ID certificate fixes both and allows notarization; `launcher/scripts/package.cjs` already uses one when `CSC_LINK` or `CSC_NAME` is set, so it needs the secret, not a code change. Default until then: stay ad-hoc signed, re-request permissions after an update, and never half-install — an installation that may not replace its bundle keeps its verified build and reports it.
- **Legal positioning** for companies: OpenAI's Terms of Use (16 January 2026) forbid automatically or programmatically extracting output, sharing an account with anyone else, and circumventing rate limits. The ChatGPT Web route automates chatgpt.com for the account's owner; CLIProxyAPI rotates subscription accounts and reuses the public Antigravity OAuth client. Both carry a risk of account restrictions that companies will ask about. Default: operate transparently within limits (R3.4, R7.5) and document the risk for users.
- **Account pooling across people** was requested (any number of accounts shared by many users to raise limits). It conflicts with the terms above and would expose customers to account bans; requirement R9 implements several accounts per owner and horizontal scaling without pooling across people. Default: accounts are used by their owner only.

