# AGENTS.md

Instructions for AI coding agents (Codex, Claude Code and others) that install, verify, update or change Codex Web GPT from this repository. Human-oriented overview: [README.md](README.md).

## Rules

- **Secrets stay with the human.** Never type, read, print or store passwords, one-time codes, API keys, cookies or the launcher's browser profile. Ask the human to sign in and to paste the Tunnel ID and API key into the launcher.
- **Respect ChatGPT's limits and checks.** Never bypass or work around rate limits, usage limits, safety checks or CAPTCHAs, and never disguise a request to get past one. When ChatGPT reports a limit, wait the stated time.
- **Never interrupt running work.** Before you quit the launcher or restart its runtime, confirm that `curl -s http://127.0.0.1:17841/healthz` reports `"active_http_turns":0` and `"active_browser_turns":0`, or run the installer with `WAIT_FOR_IDLE=1`, which waits for that itself.
- **Leave Codex's configuration to the launcher.** **Install models** and **Remove** manage the keys it owns in `~/.codex/config.toml`. Before any manual edit, copy the file with a date in its name.
- **Report evidence.** For every step, give the command and its result. Say plainly what failed or was not checked.
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

Open **Codex Web GPT**. The human performs sign-in and pastes secrets; you drive everything else and screenshot each result.

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

Expect `"connected": true` with the number of proxy models. Then ask the human to restart Codex and check that the model list shows the proxy's models. `cliproxy status` reports the connection; `cliproxy disconnect` turns it off. Codex keeps its OpenAI provider; do not add a separate `model_provider` for the proxy, which would switch off Codex features tied to that provider.

## Verify

Run every check and report each as passed or failed.

1. **Doctor.**

   ```bash
   "/Applications/Codex Web GPT.app/Contents/Resources/runtime/bin/codex-chatgpt-web" doctor
   ```

   Expect `Doctor result: ready`. A note that local checks cannot prove the connector is attached is normal; **Verify runtime** covers it.
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

- **Automatic:** installed launchers update themselves from `main` within an hour (**Settings → Automatic updates**, on by default). An update installs only if it fast-forwards the installed build, its GitHub checks passed or there are none, `bun run verify` passes on this Mac, and the new launcher reports a healthy start; otherwise the previous app stays or is restored. Nothing is replaced until Codex has been idle for five minutes.
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
| `Connection refused` on `127.0.0.1:17841` | The launcher is not running | Open Codex Web GPT |

## Develop

- Use Bun 1.4.0 exactly. Install with `bun install --frozen-lockfile` in the repository root and in `launcher/`.
- `bun run verify` must pass before anything reaches `main`: installed launchers build `main` within an hour, refuse a build that fails it, and roll back a build that does not start cleanly. A new launcher start path must still call `reportLauncherStartup` with `healthy` or `unhealthy`, or every update of it is rolled back. Run tests from a normal folder, not `/tmp`; runtime tests reject non-durable paths.
- Branches: a fix meant for upstream starts from `upstream/main` in `fix/<topic>` with a regression test; a fork-only change starts from `main` in `fork/<topic>`. Merge both into `main`, and keep `fork-build` equal to `main` for older installers.
- Keep the Full-harness contract in `src/adapters/chatgpt-web/prompt.ts` free of the vocabulary that `tests/prompt-contract.test.ts` excludes.
- Launcher interface text needs all five languages in `launcher/src/i18n.ts`.
- Architecture and security background: [docs/architecture.md](docs/architecture.md), [docs/security-model.md](docs/security-model.md), [CONTRIBUTING.md](CONTRIBUTING.md).
