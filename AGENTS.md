# AGENTS.md

Instructions for AI coding agents (Codex, Claude Code and others) that install, verify, update or change Codex Superpower (the desktop app, its bridge, and the CLIProxyAPI connection) from this repository. Human-oriented overview: [README.md](README.md).

The app shows the name **Codex Superpower**, but its bundle is still `/Applications/Codex Web GPT.app`, its data folder `~/Library/Application Support/Codex Web GPT`, its runtime home `~/.codex-chatgpt-web` and its CLI `codex-chatgpt-web`. The paths and commands below use those names on purpose.

Before changing anything in this repository, read [docs/requirements.md](docs/requirements.md) (what must always hold), [docs/engineering-process.md](docs/engineering-process.md) (how to change, test, release and repair) and [docs/roadmap.md](docs/roadmap.md) (current state and open work). They are the complete record: no earlier conversation is needed to continue the work.

## Rules

- **Secrets stay with the human.** Never type, read, print or store passwords, one-time codes, API keys, cookies or the launcher's browser profile. Ask the human to sign in and to paste the Tunnel ID and API key into the launcher.
- **Respect ChatGPT's limits and checks.** Never bypass or work around rate limits, usage limits, safety checks or CAPTCHAs, and never disguise a request to get past one. When ChatGPT reports a limit, wait the stated time.
- **Never interrupt running work.** Before you quit the launcher or restart its runtime, confirm that `curl -s http://127.0.0.1:17841/healthz` reports `"active_http_turns":0` and `"active_browser_turns":0`, or run the installer with `WAIT_FOR_IDLE=1`, which waits for that itself.
- **Leave Codex's configuration to the launcher.** **Install models** and **Remove** manage the keys it owns in `~/.codex/config.toml`. Before any manual edit, copy the file with a date in its name.
- **Report evidence.** For every step, give the command and its result. Say plainly what failed or was not checked.
- **Quitting with running turns is the human's choice.** The launcher asks before it quits while Codex has turns in flight. Never answer that dialog, and never quit or restart the launcher to fix something while a turn runs.
- **Problem reports are the human's choice.** The launcher asks before it opens a GitHub issue. Never answer that dialog for the human, and never paste logs, prompts or paths into an issue yourself; the automatic report already carries what the maintainer needs.

## Install (macOS)

1. Check the prerequisites and install whatever is missing:

   | Tool | Check | Install |
   | --- | --- | --- |
   | Git | `git --version` | `xcode-select --install` |
   | Node.js | `node --version` | `brew install node` |
   | Bun 1.4.0 exactly | `bun --version` | `curl -fsSL https://bun.sh/install \| bash -s bun-v1.4.0` |

2. Run the installer. It clones this repository into `~/.codex-chatgpt-web-source`, runs `bun run verify`, packages the app and installs it into `/Applications`; expect 5–15 minutes.

   ```bash
   curl -fsSL https://raw.githubusercontent.com/trukhinyuri/codex-superpower/main/scripts/install-fork-macos.sh | WAIT_FOR_IDLE=1 bash
   ```

   Success ends with `==> RESULT installed commit=<sha> runtime=<sha>`. A failing test stops the script before anything is installed; report the failing test.

## Set up (launcher, with Computer Use)

Open **Codex Superpower** (`/Applications/Codex Web GPT.app`). The human performs sign-in and pastes secrets; you drive everything else and screenshot each result.

1. **Onboarding.** Choose the language and **With Automation** (the default) unless the human asks for Zero Risk.
2. **Sign in.** Ask the human to sign in to ChatGPT in the launcher's embedded browser. Then press **Run browser smoke test** and wait for success.
3. **Models.** Press **Install models**. When it finishes, ask the human to quit and reopen Codex, then wait until the launcher reports that Codex loaded the model catalog.
4. **Tools (Full harness).** Open **MCP**. The human creates a Tunnel at <https://platform.openai.com/settings/organization/tunnels> and an API key at <https://platform.openai.com/settings/organization/api-keys> and pastes both. Press **Connect harness**. The human enables ChatGPT Developer Mode ([help article](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)) and creates a Tunnel connector named exactly `Codex Native2` with **Authentication: None** and **Allow all actions**. Press **Verify runtime** and wait for success.
5. **Long tasks (optional).** In **Settings**, turn on **Bigger Context**, then ask the human to restart Codex.

## Connect CLIProxyAPI (optional)

When the human runs [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) on this Mac, add its models to Codex. Ask the human where its client API key is; never print it. Pipe it in:

```bash
printf '%s' "$CLIPROXY_API_KEY" | "/Applications/Codex Web GPT.app/Contents/Resources/runtime/bin/codex-chatgpt-web" cliproxy connect --api-key-stdin
```

Expect `"connected": true` with the number of proxy models. To manage the proxy's accounts, pipe its management key the same way into `cliproxy management-key --stdin`; then `cliproxy accounts` lists them (e-mails masked; do not use `--show-emails` in a shared transcript), `cliproxy login <provider>` opens the sign-in page for the human and waits, and `cliproxy remove REF` removes one (by the `ref` from the list) after the human confirms. Then ask the human to restart Codex and check that the model list shows the proxy's models. `cliproxy status` reports the connection; `cliproxy disconnect` turns it off. Codex keeps its OpenAI provider; do not add a separate `model_provider` for the proxy, which would switch off Codex features tied to that provider. To let the launcher run and update the proxy itself, ask the human first, then `cliproxy service adopt --config <their config.yaml> --replace-label <their LaunchAgent label, if any>`; expect `"status": "running"`. `cliproxy service release` undoes it.

## Verify

Run every check and report each as passed or failed.

1. **Doctor.**

   ```bash
   "/Applications/Codex Web GPT.app/Contents/Resources/runtime/bin/codex-chatgpt-web" doctor
   ```

   Expect `Doctor result: ready` (browser-only) or `Doctor result: ready for local checks; unproven from this machine: connector` (Full harness) — the connector line names exactly what local checks cannot prove; **Verify runtime** covers it.
2. **Bridge.** `curl -s http://127.0.0.1:17841/healthz` returns `"status":"ok"`.
3. **Test turn.** Pick a ChatGPT Web model the account offers (`chatgpt-web/high` on most paid plans) and run it from a scratch folder:

   ```bash
   mkdir -p ~/cwg-check && cd ~/cwg-check && codex exec --skip-git-repo-check -m chatgpt-web/high "Reply with exactly: READY"
   ```

   Expect `READY`.
4. **Mode (Computer Use).** While a test turn runs, screenshot the launcher's **Browser** view. The mode control next to the ChatGPT composer must show the mode of the chosen model, for example **High** or **Pro**. With Bigger Context, every message of a large turn uses that mode.
5. **Tools.** In a Codex task that uses a ChatGPT Web model, ask it to run `pwd`. Expect the task folder, printed from a real Codex tool call.
6. **CLIProxyAPI (if connected).** `codex-chatgpt-web cliproxy status` reports `"reachable": true`; `codex exec --skip-git-repo-check -m <proxy model> "Reply with exactly: READY"` answers `READY`.

## Update

- **Automatic:** installed launchers update themselves from `main` within an hour (**Settings → Automatic updates**, on by default). An update installs only if it fast-forwards the installed build, its GitHub checks passed or there are none, `bun run verify` passes on this Mac, and the new launcher reports a healthy start; otherwise the previous app stays or is restored. Nothing is replaced while a turn runs: the app is swapped after ten minutes without a turn, or after one quiet minute when the installed build's recent ChatGPT Web turns all failed (nothing to protect, and the fix must not wait for the failures to stop) or the update has waited six hours; a click on the update button shortens the wait to 30 seconds.
- **In the launcher:** **Update to v…** installs an update that needs a click (for example one that failed before) with the same checks, after 30 idle seconds.
- **From a terminal:** rerun the installer command from **Install**. `WAIT_FOR_IDLE=1` waits until no ChatGPT Web turn is active, then quits and replaces the launcher; a build that does not start cleanly is rolled back.
- **Afterwards:** report the `RESULT` line and the doctor result.
- **Rollback:** the two builds replaced last are in `~/Library/Application Support/Codex Web GPT/rollback.noindex`. Restore the newest with the command below (`LIST=1` lists them, `ENTRY=<name>` picks one, `NOW=1` skips the idle wait and cancels running turns). It ends with `RESULT rolled-back commit=<sha> from=<sha>`; automatic updates then skip the commit rolled back from.

  ```bash
  curl -fsSL https://raw.githubusercontent.com/trukhinyuri/codex-superpower/main/scripts/rollback-fork-macos.sh | bash
  ```

## Troubleshoot

Evidence lives here:

| What | Where |
| --- | --- |
| Launcher and bridge | `~/Library/Application Support/Codex Web GPT/logs/launcher.jsonl` |
| Updates | `~/Library/Application Support/Codex Web GPT/logs/source-update.log`; failed commits and the last result in `source-update-state.json`, the last start in `source-update-health.json` (same folder) |
| MCP and tunnel | `~/Library/Application Support/tunnel-client/logs/codex-chatgpt-web.log` |
| Codex | `~/.codex/logs_2.sqlite` (table `logs`), `~/.codex/sessions/**/rollout-*.jsonl` |
| Browser turns (structure only, no page text) | `~/.codex-chatgpt-web/diagnostics/browser-turns/` |

| Message | Meaning | Action |
| --- | --- | --- |
| `ChatGPT rate limit … Please try again in Ns` | ChatGPT is throttling the account | Wait; Codex retries by itself. Do not restart anything. Fewer parallel tasks and subagents reduce it |
| `ChatGPT ended the turn with 'Something went wrong'` | A ChatGPT error; right after a rate limit it counts as that limit | Let Codex retry |
| ChatGPT stopped a tool call before it ran | ChatGPT's own check stopped it; it never reached Codex, the tunnel or the target service | Do not declare the service unavailable. Ask for one clear operation, or run that step with a native Codex model. Reading Codex session transcripts through a ChatGPT Web model is a known trigger |
| `ChatGPT stopped responding after the task started` or `did not confirm that the prompt was sent` | The ChatGPT tab was slow or hidden, often under heavy CPU load | Keep the launcher running with **Show browser during turns** on, and retry |
| `exceeds the measured … ChatGPT browser message boundary` | The context does not fit one message | Turn on Bigger Context, or run `/compact` |
| `missing cwd in trusted Codex environment context` | Not expected in this fork, including skills outside Git and multi-folder projects | Collect the turn's rollout and the matching `trusted environment unavailable (…)` line from `launcher.jsonl`, then open an issue in this repository |
| `Connection refused` on `127.0.0.1:17841` | The launcher is not running | Open Codex Superpower |

## Develop

- If Codex on this computer runs through the installed build, follow [docs/self-hosted-development.md](docs/self-hosted-development.md): an agent that breaks the bridge loses every model it could repair it with.
- Use Bun 1.4.0 exactly. Install with `bun install --frozen-lockfile` in the repository root and in `launcher/`.
- `bun run verify` must pass before anything reaches `main`: installed launchers build `main` within an hour, refuse a build that fails it, and roll back a build that does not start cleanly. A new launcher start path must still call `reportLauncherStartup` with `healthy` or `unhealthy`, or every update of it is rolled back. Run tests from a normal folder, not `/tmp`; runtime tests reject non-durable paths.
- Keep the packaging identities that installed launchers depend on: `build.executableName` "Codex Web GPT" (the bundle name and executable), `appId`, `artifactName`, the `CodexWebGptSource*` Info.plist stamps, the userData folder and the browser partition. Launchers released before the rename install only packages that keep them; `launcher/scripts/updater-compatibility.cjs` fails `bun run app:package` otherwise, and `launcher/tests/legacy-updater-contract.test.cjs` runs that older updater against the new layout.
- Branches: a fix meant for upstream starts from `upstream/main` in `fix/<topic>` with a regression test; a fork-only change starts from `main` in `fork/<topic>`. Merge both into `main`, and keep `fork-build` equal to `main` for older installers.
- Keep the Full-harness contract in `src/adapters/chatgpt-web/prompt.ts` free of the vocabulary that `tests/prompt-contract.test.ts` excludes.
- Launcher interface text needs all five languages in `launcher/src/i18n.ts`.
- `cliproxyapi/` is [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (Go), imported as a squashed `git subtree` of the `superpower` branch of [trukhinyuri/vibeflow](https://github.com/trukhinyuri/vibeflow): upstream plus this project's fixes. `bun run verify` builds and tests it (`scripts/verify-cliproxyapi.ts`) with the Go toolchain pinned in `scripts/cliproxyapi-build.json`, which the build downloads from go.dev and checks by SHA-256 on first use (`CODEX_SUPERPOWER_GO` overrides it; caches live in `~/Library/Caches/codex-superpower`). Skip a Go test only for timing or network flakiness, in `FLAKY_GO_TESTS` with the reason.
- Upstream embeds the OAuth client of the public Antigravity app in its source. This repository never carries it: verify fails on such a literal in `cliproxyapi/`, and the build reads it from upstream at the commit pinned in `scripts/cliproxyapi-build.json` (SHA-256 checked) and passes it to the Go linker. To sync upstream, rebase `superpower` in a CLIProxyAPI clone onto the new upstream release (keep the commit that turns the client into build-time variables), push it, then squash it in on a branch and verify:

  ```bash
  git fetch https://github.com/trukhinyuri/vibeflow.git superpower
  git subtree merge --prefix=cliproxyapi --squash FETCH_HEAD
  bun run verify
  ```

  Never `git subtree pull` from upstream directly: its history carries the literal. If upstream changed `internal/auth/antigravity/constants.go`, update its commit and SHA-256 in `scripts/cliproxyapi-build.json`.
- Architecture and security background: [docs/architecture.md](docs/architecture.md), [docs/security-model.md](docs/security-model.md), [CONTRIBUTING.md](CONTRIBUTING.md).
