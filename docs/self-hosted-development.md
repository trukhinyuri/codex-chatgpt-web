# Developing Codex Superpower from a Codex session that runs through it

Codex Superpower sits between Codex and every model Codex uses: `openai_base_url` in `~/.codex/config.toml` points at the bridge on `127.0.0.1:17841`, including for native OpenAI models. If the installed bridge stops working, Codex on that computer cannot reach any model, and an agent working through it cannot repair it. These rules keep development of this repository safe on any computer where the installed build carries live work.

## Rules

1. **Never change the installed app directly.** Work in your own clone of this repository, never in `~/.codex-chatgpt-web-source` (the launcher's managed clone) and never inside `/Applications/Codex Web GPT.app`.
2. **Isolate every test run.** Run tests and `bun run verify` with a private temporary folder outside `/tmp`, for example `TMPDIR="$HOME/.cache/codex-superpower-dev/tmp"`. Updater tests create and delete staged builds; with the system temporary folder they can delete the build the installed launcher is about to install.
3. **Ship only through `main`.** Push to `main` only commits that passed `bun run verify` in a clean clone. Installed launchers build `main` themselves, run the full suite, install only while no turn runs (after 10 idle minutes; 1 minute when the installed build's turns only fail or the update waited 6 hours; 30 seconds after a click on the update button), and roll back a build that does not report a healthy start within 6 minutes. Never run the installer script from a development branch on the computer you work on.
4. **Keep one route working while you change another.** While you change the ChatGPT Web path, do the development itself with a native OpenAI model (it passes through the bridge unchanged); while you change the native pass-through, keep a second computer or a Codex installation without `openai_base_url` at hand.
5. **Never interrupt running work.** Before anything that restarts the launcher or its runtime, `curl -s http://127.0.0.1:17841/healthz` must report `"active_http_turns":0` and `"active_browser_turns":0`. The launcher asks before quitting with turns in flight; never answer that dialog for the human.
6. **Keep contexts bounded.** A Codex thread whose context reaches hundreds of thousands of characters makes every ChatGPT Web turn large. Start a new thread with a short handoff (state, next step, files) instead of loading whole transcripts into one thread.

## If the installed build breaks

Try these in order. Each works without the launcher's interface.

1. **Roll back** to the build that was replaced last (the two previous builds are kept):

   ```bash
   curl -fsSL https://raw.githubusercontent.com/trukhinyuri/codex-superpower/main/scripts/rollback-fork-macos.sh | bash
   ```

   Automatic updates then skip the commit rolled back from until a newer one arrives.
2. **Take Codex off the bridge** when no build of the launcher works: `codex-chatgpt-web uninstall --yes` (in `/Applications/Codex Web GPT.app/Contents/Resources/runtime/bin/`) restores the values Codex had before the launcher changed its configuration. Codex then uses its own OpenAI route; the ChatGPT Web and CLIProxyAPI models are unavailable until the launcher's **Install models** runs again.
3. **Reinstall** from `main` with the installer in [AGENTS.md](../AGENTS.md#install-macos); it waits for Codex to be idle.

## Release checklist

- [ ] The change has a regression test that fails without it.
- [ ] `bun run verify` passes in a clean clone with an isolated `TMPDIR`.
- [ ] The commit is a fast-forward of `main`.
- [ ] After the push, the installed launcher reports the new commit (`defaults read "/Applications/Codex Web GPT.app/Contents/Info" CodexWebGptSourceCommit`) and `curl -s http://127.0.0.1:17841/healthz` reports `"status":"ok"`.
- [ ] A ChatGPT Web turn, a native OpenAI turn and, if connected, a CLIProxyAPI turn each answer.
