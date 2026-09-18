# Agent playbook

What an AI agent does when a person points it at this repository and says one short word, in any language, from any harness (Codex, Claude Code or another), without earlier conversation. The project's knowledge is in this repository: [requirements.md](requirements.md) (what must always hold), [engineering-process.md](engineering-process.md) (how work is done), [roadmap.md](roadmap.md) (state and open work), [plans/](plans/), and the GitHub issues and pull requests of trukhinyuri/codex-superpower.

## Recognise the request

| The person says (any language, any wording with this meaning) | Do |
| --- | --- |
| "set up", "install", "настрой", "установи", "configure", "einrichten", "设置" … | [Set up](#set-up) |
| "continue", "продолжи", "go on", "weiter", "继续" … | [Continue](#continue) |
| anything else | Treat it as a task: read requirements.md and engineering-process.md, then do it the same way |

Answer the person in their language. Commands, code, commit messages and repository documents stay in English.

## Set up

Goal: the product works on this computer and the person did nothing but sign in.

1. Follow [../AGENTS.md](../AGENTS.md): prerequisites, the installer, launcher setup with the person signing in themselves, and every check under Verify.
2. If the computer already runs an installed build, do not reinstall: check its health (`codex-chatgpt-web doctor`, `/healthz`, a test turn per route) and repair only through the product (update, rollback, the launcher's own actions).
3. Report each step with its evidence, in the person's language.

## Continue

Goal: the next most valuable change reaches users, verified, without asking the person what to do. Ask only for what only a person can do: signing in, secrets, and the decisions listed in roadmap.md under "Decisions for the owner".

1. **Sync.** `git fetch --all`; read requirements.md, engineering-process.md, roadmap.md. Check that no other agent is releasing (open draft pull requests, recent pushes to `main`); coordinate instead of racing.
2. **Collect the work queue**, most urgent first:
   1. Users are hurt now: open issues labelled `auto-report` (problem reports from installed apps), newest and most frequent first.
   2. `main` is red: failing CI on `main` blocks every user's update (`gh run list -R trukhinyuri/codex-superpower --branch main`).
   3. The outside world changed: open issues labelled `auto-watch` (a new Codex version, new upstream releases, active forks) opened by the daily watch workflow.
   4. Open work in roadmap.md "In progress", then "Next", in order.
   5. When the queue is empty: run the [failure-mode review](engineering-process.md#when-something-breaks-for-users) and the [competitive review](engineering-process.md#staying-ahead) and add what they find to roadmap.md.
3. **Do the first item** by engineering-process.md: branch, regression test first, implementation, isolated tests, the updater's build path, draft pull request for CI when the change is risky.
4. **Release** it (engineering-process.md "Releasing"), watch CI on `main`, confirm an installed app picks it up if you can observe one.
5. **Record.** Update roadmap.md (move the item, add what you learned), close or comment on the issues it resolves, update competitive-analysis.md when you ported or surpassed something.
6. **Repeat** from step 1 until the person stops you or only owner decisions remain. Then summarise, in the person's language, what reached users and what waits for them.

## Rules that never bend

- Never repair one computer by hand; fixes ship through `main` (requirement R1.1).
- Never interrupt a running Codex turn, never answer the launcher's dialogs for the person.
- Never bypass or disguise traffic to get past a provider's limits, checks or detection (R3.4, R7.5); never share one person's account with another (R9.6).
- Never type, read, print or store passwords, codes, keys or cookies.
- Never commit secrets; never push to `main` a commit that did not pass the updater's build path.
