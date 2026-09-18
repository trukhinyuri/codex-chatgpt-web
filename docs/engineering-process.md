# Engineering process

How to change, test, release and repair Codex Superpower so that [requirements.md](requirements.md) hold. It is written for AI agents and people who continue the work without earlier conversations. Read [../AGENTS.md](../AGENTS.md) for installing and operating the product, and [self-hosted-development.md](self-hosted-development.md) if Codex on your computer runs through the build you are changing.

## Principles

- **The updater is the only way a fix reaches users.** Never repair one computer by hand, and never test a fix only by editing an installed app, `~/.codex/config.toml` or the bridge state. Change the code, ship it through `main`, and let installed apps update.
- **A change is done when it is released and verified**, not when it is written: tests pass in a clean clone, the updater's build path passes, CI on macOS is green, and the installed app picks it up.
- **Evidence over belief.** Every claim in a commit message, document or report is backed by a test, a log line or a command output. Unverified things are marked as such.
- **Record what you decide.** Requirements go to [requirements.md](requirements.md), process to this file, open work to [roadmap.md](roadmap.md), larger plans to [plans/](plans/).

## Repository layout

| Path | What |
| --- | --- |
| `src/` | The bridge runtime (Bun/TypeScript, CLI `codex-chatgpt-web`, `127.0.0.1:17841`): Responses API for Codex, ChatGPT Web adapter (`src/adapters/chatgpt-web/`), native OpenAI pass-through, CLIProxyAPI routing (`src/cliproxy*.ts`). |
| `launcher/` | The Electron app: embedded ChatGPT browser, runtime supervisor, updater (`electron/source-update*.cjs`, `electron/update-idle-policy.cjs`), problem reports, UI (`src/`, five languages in `src/i18n.ts`). |
| `cliproxyapi/` | [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (Go) as a squashed subtree of the `superpower` branch of [trukhinyuri/vibeflow](https://github.com/trukhinyuri/vibeflow). |
| `scripts/` | `verify.ts` (the release gate), `verify-cliproxyapi.ts`, `cliproxyapi-build.*` (pinned Go toolchain and build inputs), installer and rollback scripts for macOS. |
| `docs/` | Requirements, process, roadmap, plans, architecture, security model. `docs/upstream/` is the original project's documentation; do not edit it. |

## Working safely

- Work in your own clone or git worktree, on a branch. Never in `~/.codex-chatgpt-web-source` (the updater's managed clone).
- **Isolate every test run** with a private `HOME` and `TMPDIR`, and keep the path short: macOS limits unix socket paths to 103 bytes and some tests create sockets under `TMPDIR`. For example:

  ```bash
  SB="$HOME/.wf/<short-id>"; mkdir -p "$SB/home" "$SB/tmp"
  HOME="$SB/home" TMPDIR="$SB/tmp" bun test --timeout 60000 ./tests
  (cd launcher && HOME="$SB/home" TMPDIR="$SB/tmp" node --test tests/*.test.cjs)
  ```

  Tests that use the real home or system temporary folder have deleted a live launcher's staged update and written the live bridge state before; both are now guarded by tests, keep it that way.
- Never quit, restart or relaunch an installed app, and never answer its dialogs, while Codex has turns in flight.
- Parallel agents or sessions: one integrator releases; others hand over branches and do not push `main`. Tell each other which files you are changing.
- Commits and merges use the owner's identity and no AI attribution lines:

  ```bash
  git -c user.name="Yuri Trukhin" -c user.email="yuri@trukhin.com" commit
  ```

  Before a push, check every new commit: `git log --format='%an <%ae>' origin/main..HEAD`.

## Making a change

1. Read the requirement the change serves and the code it touches. Check the logs of a real installation (`~/Library/Application Support/Codex Web GPT/logs/launcher.jsonl`, `~/.codex-chatgpt-web/diagnostics/browser-turns/`) for what actually happens; they contain no conversation text, and you must not copy any that you find elsewhere.
2. Write the regression test first when fixing a failure; it must fail without the fix.
3. Keep `src/adapters/chatgpt-web/prompt.ts` free of the vocabulary `tests/prompt-contract.test.ts` excludes. Launcher text needs all five languages.
4. Anything Codex parses (model catalog rows, `response.failed` codes, SSE events) must be checked against the Codex source of the versions users run (openai/codex, `codex-rs`); Codex rejects a whole catalog for one invalid row, and retries unknown error codes up to five times.
5. Run the targeted tests, the full suites and both typechecks (`bun run typecheck`, `cd launcher && bunx --no-install tsc --noEmit`) with the isolation above.

## Releasing

1. Merge the branches of the release into one branch on top of `origin/main` (fast-forward only on `main`).
2. In a clean clone, run the **updater's build path** exactly as installed apps run it: private home, `bun install --frozen-lockfile` (root and `launcher/`), `bun run verify`, `bun run app:package`. `launcher/electron/source-update.cjs` exports `prepareBuildHome`, `sourceBuildEnvironment` and `sourceBuildSteps` for this. `bun run verify` alone does not package; the updater does.
3. Push the same commit to `main` and `fork-build` (older installers follow `fork-build`):

   ```bash
   git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push origin <sha>:refs/heads/main <sha>:refs/heads/fork-build
   ```

4. Watch CI (`gh run list -R trukhinyuri/codex-superpower`). Installed apps install a commit by themselves only when its macOS CI checks passed; a red macOS job blocks every user's update until fixed. Fix Windows and Linux failures too, in the next release.
5. To run CI without releasing (a test-only change, a risky change), open a draft pull request in this repository; CI runs on pull requests.
6. After an installed app picks the release up, check its version (`defaults read "/Applications/Codex Web GPT.app/Contents/Info" CodexWebGptSourceCommit`), `curl -s http://127.0.0.1:17841/healthz`, and a turn on each route.
7. Update [roadmap.md](roadmap.md).

Every release makes every installed app rebuild itself for several minutes. Batch small changes; do not release a documentation or test-only change on its own.

## Identities that must not change

Installed updaters, users' data and Codex's configuration depend on these. Changing any of them needs a migration designed, tested against the oldest installed updater still in use, and released on its own.

| Identity | Value |
| --- | --- |
| App bundle file and executable | `Codex Web GPT.app`, `Contents/MacOS/Codex Web GPT` (the updater at `86f2d311` refuses any other executable name) |
| Bundle id | `dev.codexwebgpt.launcher` |
| Package artifact name | `codex-web-gpt-<version>-mac-<arch>.zip` |
| Info.plist stamps | `CodexWebGptSourceCommit`, `CodexWebGptSourceState` |
| User data | `~/Library/Application Support/Codex Web GPT`, browser partition `persist:codex-web-gpt-chatgpt` |
| Bridge home and CLI | `~/.codex-chatgpt-web`, `codex-chatgpt-web`, health `service: "codex-chatgpt-web"` |
| Codex config markers | the managed comments in `src/codex-integration-shared.ts`, `src/codex-interrupt-hook.ts` |
| Updater files | `source-update-state.json`, `source-update-health.json`, `rollback.noindex`, staging prefix `codex-web-gpt-update-` |
| Embedded browser User-Agent | product token `CodexWebGPT/<version>` next to the unchanged `Chrome/…` and `Electron/…` tokens (`launcher/electron/user-agent.cjs`); Cloudflare binds its clearance on chatgpt.com to the User-Agent |

The product's visible name is **Codex Superpower**; everything above keeps the old technical names on purpose.

## Upstream projects

- **codex-chatgpt-web** (`upstream` = miuuyy/codex-chatgpt-web): a fix useful upstream starts from `upstream/main` in `fix/<topic>` with a regression test, is merged here, and may be offered upstream as a pull request. Review upstream pull requests and active forks regularly for fixes to port; do not port a change that sends tokens to third parties or updates from someone else's repository.
- **CLIProxyAPI**: sync through the `superpower` branch of trukhinyuri/vibeflow as described in [../AGENTS.md](../AGENTS.md#develop); never `git subtree pull` from upstream directly (its history carries OAuth client secrets that GitHub push protection rejects, and this repository must never contain them).

## Staying ahead

Each release cycle: list new releases, merged and open pull requests, and actively developed forks of codex-chatgpt-web and CLIProxyAPI (for example `gh api repos/miuuyy/codex-chatgpt-web/forks --paginate`, sorted by recent pushes), and tools that solve the same problem. For each change that helps users, port it with a regression test, do better, or record why not in [competitive-analysis.md](competitive-analysis.md). Never port a change that sends credentials or content to third parties, or that updates from someone else's repository.

## When something breaks for users

1. Find the failure class from logs and diagnostics (structure only), count it, and find the code path.
2. Decide how the product should heal it automatically (R2). Add it to [roadmap.md](roadmap.md) if it is not fixed in the same change.
3. Fix, test, release as above. If the installed build cannot start, installed apps roll back by themselves; if they cannot reach any model, [self-hosted-development.md](self-hosted-development.md#if-the-installed-build-breaks) lists the recovery steps.
