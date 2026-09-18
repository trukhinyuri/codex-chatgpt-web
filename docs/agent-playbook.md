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

Goal: the next most valuable change reaches users, verified, without asking the person what to do and without waiting for decisions (see [research](#research), step 6). Ask only for what only a person can do: signing in, secrets, paying, accepting terms.

1. **Sync.** `git fetch --all`; read requirements.md, engineering-process.md, roadmap.md. Check that no other agent is releasing (open draft pull requests, recent pushes to `main`); coordinate instead of racing.
2. **Collect the work queue**, most urgent first:
   1. Users are hurt now: open issues labelled `auto-report` (problem reports from installed apps), newest and most frequent first.
   2. `main` is red: failing CI on `main` blocks every user's update (`gh run list -R trukhinyuri/codex-superpower --branch main`).
   3. The outside world changed: open issues labelled `auto-watch` (a new Codex version, new upstream releases, active forks) opened by the daily watch workflow.
   4. Open work in roadmap.md "In progress", then "Next", in order.
   5. When the queue is empty: [research](#research) what would help users most (a failure-mode review from install to support, the [competitive review](engineering-process.md#staying-ahead), measurements of latency and throughput) and add what it finds to roadmap.md.
3. **Do the first item** by engineering-process.md: branch, regression test first, implementation, isolated tests, the updater's build path, draft pull request for CI when the change is risky.
4. **Release** it (engineering-process.md "Releasing"), watch CI on `main`, confirm an installed app picks it up if you can observe one.
5. **Record.** Update roadmap.md (move the item, add what you learned), close or comment on the issues it resolves, update competitive-analysis.md when you ported or surpassed something.
6. **Repeat** from step 1 until the person stops you. Then summarise, in the person's language, what reached users and what waits for them.

## Research

Research turns an open question into a decision that ships. Do it before any change whose right answer is not obvious from the code, and whenever the queue is empty.

1. **Frame the question** as the decision it serves: "What should the bridge do when X happens, so that requirement Rn holds?" Write down what would change the answer.
2. **Gather evidence from primary sources**, never from memory:
   - this repository's code and tests, and its history (`git log -S`, blame);
   - behaviour of real installations: structural logs and diagnostics (`launcher.jsonl`, `diagnostics/browser-turns/`), problem-report issues. Never read or copy conversation content;
   - the source of the software the product talks to, at the versions users run: openai/codex (`codex-rs`: catalog schema, retry rules, SSE events), Electron, Playwright, CLIProxyAPI;
   - upstream projects, their issues, pull requests and active forks;
   - provider documentation and terms (OpenAI, Anthropic, Google): what is allowed decides what is built.
3. **Measure instead of guessing**: count events per class and hour, time the paths, reproduce the failure in a test or a sandbox (a separate app-server or bridge instance with its own home). Record the query or command that produced every number.
4. **Challenge the conclusion**: give the question to independent reviewers with different lenses (correctness, compatibility with the other side of each boundary, risk and privacy, "try to break it") without showing them your answer; if your harness can run several agents, use them in parallel. Resolve contradictions with evidence, not votes.
5. **Write it down** in `docs/plans/<date>-<topic>.md`: question, evidence with sources, options, decision, increments with tests and live checks, and what could not be verified. Add the increments to roadmap.md.
6. **Decide yourself and keep going.** Never stop to wait for a decision. When the requirements settle the question, follow them. When they do not, choose the option that keeps every requirement, is reversible and is the most conservative towards users' work and accounts, record the choice and why in the plan and in roadmap.md "Decisions for the owner" as a default the owner may change, and continue. The only things you never decide on a person's behalf are the ones only a person can do (signing in, secrets, paying, accepting terms) and anything that would break a requirement; for those, apply the requirement-compliant default and move on to other work.
7. **Revisit approaches as the world changes.** Each cycle, read the technology-watch issue (new releases of Codex, Electron, Playwright, Bun, Go, other agent harnesses) and ask whether a newer approach now serves a requirement better than the current one: a new Codex capability that removes a workaround, a faster transport, a better way to measure. Research it the same way and replace the old approach when the evidence says so.

## Rules that never bend

- Never repair one computer by hand; fixes ship through `main` (requirement R1.1).
- Never interrupt a running Codex turn, never answer the launcher's dialogs for the person.
- Never bypass or disguise traffic to get past a provider's limits, checks or detection (R3.4, R7.5); never share one person's account with another (R9.6).
- Never type, read, print or store passwords, codes, keys or cookies.
- Never commit secrets; never push to `main` a commit that did not pass the updater's build path.
