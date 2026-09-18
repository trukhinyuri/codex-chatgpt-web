# Product requirements

These requirements come from the owner (Yuri Trukhin) and bind every change to this repository. Codex Superpower is a paid product that companies and individuals use for critical work, often in many parallel Codex sessions; development of this product itself also runs through it. When a change would break a requirement, the change is wrong, not the requirement. [engineering-process.md](engineering-process.md) describes how the requirements are met and checked; [roadmap.md](roadmap.md) lists where the product still falls short.

## R1. It works for everyone, on any computer

1. Every behaviour is designed and tested for every supported user, not for one machine. A fix that works only on the developer's computer, or a manual repair on one computer, is not a fix: the change ships through `main` and the updater, or it does not exist.
2. A person without technical knowledge installs, sets up and uses the product. After the first install nothing needs maintenance: no configuration files to edit, no accounts to configure by hand, no commands to run to keep it working.
3. Supported platform: macOS on Apple silicon and Intel. Code paths for Windows and Linux inherited from upstream must keep passing CI, but they are not advertised as supported until they meet these requirements.

## R2. Problems are found and healed automatically

1. Every failure the product can detect is either healed without the user (retry with the right delay, wait for a limit to end, reload a page, restart a component, roll back a build, fall back to the last good data) or reported with exactly what happens next and at most one action for the user.
2. A failure the product cannot heal is reported to the maintainer automatically ([problem reports](../README.md#problem-reports)), without any user data (see R7).
3. Error text shown to users never tells them to edit files, check tabs, disable features, or retry by hand when the product could do that itself.

## R3. Work is never lost or interrupted

1. No automatic action interrupts a running Codex turn: updates, restarts, rollbacks and repairs wait until no turn runs. Only an explicit choice of the user in a dialog may stop running work.
2. Context is never truncated to make something fit. Large tasks work by splitting, staging and compaction that keeps the task; a request that cannot fit is reported, not silently shortened.
3. Tasks of any size and any number of parallel sessions work; load is paced and queued, never answered with an error that a wait would have avoided.
4. Provider limits (ChatGPT rate limits, usage caps, proxy quotas) are respected, never bypassed or disguised; the product waits for them to end and says so.
5. Concurrency is always correct: any number of parallel sessions, subagents and Codex hosts share the bridge without lost, duplicated or cross-wired turns, with one ChatGPT account as with many.

## R4. Updates either work or do not happen

1. Installed apps update themselves from `main`. An update is installed only if it passed CI on macOS, the full test suite on the user's Mac, and a healthy start; otherwise the previous build stays or is restored automatically, and the failed commit is not retried unattended.
2. The updater must deliver a fix to a build that is failing: an installation whose turns all fail has no work to protect and installs the fix in the first quiet minute.
3. A transient failure (network, registry, a flaky test) never blocks updates permanently; a real regression never installs.
4. An update build never touches the user's state: it runs in a private home, and tests never write outside their temporary folders.
5. The previous two builds are kept for rollback; rollback is one command and automatic after a bad start.
6. The first install is the only manual step.

## R5. Codex keeps everything it has

1. Codex keeps its own sign-in, provider (OpenAI) and every feature: tools, plugins, computer use, browser, Computer History, web search, skills, agents and subagents, compaction, approvals. Nothing in this product may switch Codex to a custom model provider as the default route.
2. Models from all routes appear in one model list: ChatGPT Web modes, native OpenAI models, and CLIProxyAPI models. A bad row from any source never removes the others (Codex rejects the whole catalog for one invalid row).
3. A Codex update that changes the protocol is detected, and the product degrades to a working route instead of failing every turn.

## R6. The app behaves like a normal Mac app

1. It lives in the Dock, starts at login, and restarts itself after a crash. The menu-bar icon is optional.
2. It is named **Codex Superpower** everywhere a user sees it. The bundle file name, executable name, bundle id, data folders and wire identifiers stay unchanged, because installed updaters and users' data depend on them (see [engineering-process.md](engineering-process.md#identities-that-must-not-change)).
3. Authors: Yuri Trukhin (<yuri@trukhin.com>, fork), based on codex-chatgpt-web by miuuyy; MIT License.

## R7. Privacy and security

1. Logs, diagnostics, problem reports and GitHub issues never contain prompts, answers, file contents, paths of user projects, account names, e-mail addresses, tokens or keys.
2. Secrets stay with the human: agents never type, read, print or store passwords, one-time codes, API keys or cookies.
3. No OAuth client secrets or other credentials are committed; build inputs from outside the repository are pinned by version and SHA-256.
4. The bridge listens only on loopback and rejects foreign origins.

## R8. Quality

1. Every behaviour change has a regression test that fails without it; no existing behavioural assertion is weakened.
2. `bun run verify` passes in a clean clone, and the updater's own build path (private home, full suite, packaging) is exercised before a release.
3. Problems known from upstream projects (codex-chatgpt-web, CLIProxyAPI) and their forks are fixed here too, not carried over.
4. Everything that is decided or learned is written into this repository (requirements, process, roadmap, plans), so any agent can continue without the conversation in which it happened.

## R9. Many ChatGPT accounts scale horizontally

1. The user can connect several ChatGPT accounts. Each keeps its own sign-in, limits and connector; adding an account adds capacity for parallel work.
2. Turns are distributed across healthy accounts by load and limits; an account in cooldown or signed out takes no new turns while the others continue. No global lock or single component serializes work across accounts, and the loss of one account never stops the others.
3. Work that depends on an account (a retained conversation, a continuation, a compaction) stays on that account or is moved safely, never mixed.
4. With one account, everything works exactly as before; more accounts never change correctness, only capacity.
