# Roadmap and current state

Updated with every release. It lists where the product still falls short of [requirements.md](requirements.md) and what is being done about it. Detailed plans are in [plans/](plans/).

## Released

| Release | Commit | What changed for users |
| --- | --- | --- |
| R9 | `10a30a6b` | The update button explains what a pending update waits for and installs it 30 s after Codex's tasks; network failures, new advisories and a test that fails once under load no longer block updates. |
| R10 | `b158e12e` | CLIProxyAPI is part of the repository and the app; the Go toolchain and the Antigravity OAuth client are fetched at build time, pinned by SHA-256, so the repository holds no secrets and needs no local Go. |
| R11 | `38dcd221` | A failing installation receives its fix in the first quiet minute; update builds run in a private home and cannot touch user state; one invalid proxy model can no longer empty Codex's model list; the catalog stays within the 100 rows Codex Desktop reads. First release checked by CI on macOS. |

## In progress

1. **ChatGPT Web reliability, wave 1** ([plan](plans/2026-09-18-bridge-reliability.md), sections 1.1–1.4, 2.1–2.2, 5.1–5.6). On 18.09 about twice as many ChatGPT Web turns failed as completed, from three causes:
   - The bridge refused turns during ChatGPT's rate-limit cooldown instead of waiting.
   - Codex retried errors the bridge marked final, up to five times each, and parallel sessions escalated the pause to five minutes.
   - Large Bigger Context messages failed with "Something went wrong" and were resent unchanged.

   Wave 1 makes errors final for Codex when they are final, holds turns in an account-wide admission gate with paced release instead of refusing them, serializes the heavy browser phases, keeps a last-good model catalog, and verifies the ChatGPT connector automatically.
2. **Visible rename to Codex Superpower** with authors and About panel (branch `fork/rename-visible`). It is compatible with the updater at `86f2d311`, as the legacy-updater contract test shows, and is under review.
3. **Dock, start at login, restart after a crash** through a LaunchAgent with KeepAlive; the menu-bar icon becomes optional (branch `fork/dock-autostart-keepalive`).
4. **Failure-mode review for thousands of users**: every way a user can get stuck, from install to support, checked against the code. Result: `plans/failure-modes.md`.
5. **Windows CI**: the proxy tests assumed POSIX paths and file modes. Fixed in pull request #1; it ships with the next release.

## Next

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

- **Signing:** builds are ad-hoc signed, so macOS privacy permissions granted to the app are tied to one build and reset with every update. A Developer ID certificate would fix this and allow notarization. Default: stay ad-hoc signed and re-request permissions after an update.
- **Legal positioning** for companies: OpenAI's Terms of Use (16 January 2026) forbid automatically or programmatically extracting output, sharing an account with anyone else, and circumventing rate limits. The ChatGPT Web route automates chatgpt.com for the account's owner; CLIProxyAPI rotates subscription accounts and reuses the public Antigravity OAuth client. Both carry a risk of account restrictions that companies will ask about. Default: operate transparently within limits (R3.4, R7.5) and document the risk for users.
- **Account pooling across people** was requested (any number of accounts shared by many users to raise limits). It conflicts with the terms above and would expose customers to account bans; requirement R9 implements several accounts per owner and horizontal scaling without pooling across people. Default: accounts are used by their owner only.
