# Product requirements

These requirements come from the owner (Yuri Trukhin) and bind every change to this repository. Codex Superpower is a paid product that companies and individuals use for critical work, often in many parallel Codex sessions; development of this product itself also runs through it. When a change would break a requirement, the change is wrong, not the requirement. [engineering-process.md](engineering-process.md) describes how the requirements are met and checked; [roadmap.md](roadmap.md) lists where the product still falls short.

**The measure of success:** every user's work runs without interruption, and users never have to think about the product. Each requirement below serves this; when they seem to conflict, choose what keeps users' work running, correctly.

## R1. It works for everyone, on any computer

1. Every behaviour is designed and tested for every supported user, not for one machine. A fix that works only on the developer's computer, or a manual repair on one computer, is not a fix: the change ships through `main` and the updater, or it does not exist.
2. A person without technical knowledge installs, sets up and uses the product. After the first install nothing needs maintenance: no configuration files to edit, no accounts to configure by hand, no commands to run to keep it working.
3. Platforms, in this order: macOS on Apple silicon now; then Windows (x64, arm64), Linux (x64, arm64) and macOS on Intel. Until a platform meets every requirement here it is not advertised as supported, but its code paths keep passing CI so that it does not fall behind.
4. Harnesses: Codex Desktop and Codex CLI now; other popular agent harnesses later, through the same core without rewriting it. Features companies need (central deployment, policy, audit, support) come after the individual product is complete.

## R2. Problems are found and healed automatically

1. Every failure the product can detect is either healed without the user (retry with the right delay, wait for a limit to end, reload a page, restart a component, roll back a build, fall back to the last good data) or reported with exactly what happens next and at most one action for the user.
2. A failure the product cannot heal is reported to the maintainer automatically ([problem reports](../README.md#problem-reports)), without any user data (see R7).
3. Error text shown to users never tells them to edit files, check tabs, disable features, or retry by hand when the product could do that itself.
4. The whole loop runs without people: a problem is detected, reported anonymously (no user data, no user identity), triaged and planned by agents, fixed, released gradually and verified, and the same happens when an operating system, a technology or a harness changes. Users are told only what affects them, in their language, and never need to act.
5. A mode or control a provider stops offering an account degrades to the nearest one it still offers, with the change recorded; the product never repeats a request for a control that is not there.
6. A provider's own account check is detected and obeyed, never retried. When ChatGPT holds an account — its suspicious-activity banner, or a model and effort menu that no longer carries this account's controls — the product stops automatic turns for that account until a person has secured it and signed in again, answers every waiting turn with one terminal error naming one action (secure the account and sign in), and writes only a structural diagnostic (see R7.1) and no repeats. See [incidents/2026-09-18-account-lock.md](incidents/2026-09-18-account-lock.md).

## R3. Work is never lost or interrupted

1. No automatic action interrupts a running Codex turn: updates, restarts, rollbacks and repairs wait until no turn runs. Only an explicit choice of the user in a dialog may stop running work.
2. Context is never truncated to make something fit. Large tasks work by splitting, staging and compaction that keeps the task; a request that cannot fit is reported, not silently shortened.
3. Tasks of any size and any number of parallel sessions work; load is paced and queued, never answered with an error that a wait would have avoided. Pacing is per account and shared by every session and harness on it: a minimum distance between sends, and after any failure ChatGPT itself ends a turn with, a pause that starts at 60 s and doubles per consecutive failure to a ceiling of 5 minutes, cleared by one clean turn.
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

1. Logs, diagnostics, problem reports and GitHub issues never contain prompts, answers, file contents, paths of user projects, account names, e-mail addresses, tokens or keys, and never reveal who sent them.
2. Secrets stay with the human: agents never type, read, print or store passwords, one-time codes, API keys or cookies.
3. No OAuth client secrets or other credentials are committed; build inputs from outside the repository are pinned by version and SHA-256.
4. The bridge listens only on loopback and rejects foreign origins.
5. The product does not disguise what it is. It never spoofs a browser, hides its automation, or evades a provider's detection or protective measures; it reduces the risk of account restrictions by staying within limits and terms, not by concealment. It also declines the shapes of traffic that get accounts restricted: **ChatGPT Web — Pro is excluded, and the highest mode the product offers is Extra High.**

## R8. Quality

1. Every behaviour change has a regression test that fails without it; no existing behavioural assertion is weakened.
2. `bun run verify` passes in a clean clone, and the updater's own build path (private home, full suite, packaging) is exercised before a release.
3. Problems known from upstream projects (codex-chatgpt-web, CLIProxyAPI) and their forks are fixed here too, not carried over.
4. Everything that is decided or learned is written into this repository (requirements, process, roadmap, plans), so any agent can continue without the conversation in which it happened.
5. The project improves itself without being given tasks: problem reports from installed apps and a daily watch of Codex releases, upstream projects and forks open issues automatically, and an agent told only "continue" or "set up", in any language and from any harness, finds and finishes the most valuable work by [agent-playbook.md](agent-playbook.md).
6. Performance: every path is built for the highest throughput and the lowest latency the providers allow (no avoidable waits, polling, serialization or repeated work on the hot path), but never at the cost of correctness or stability; latency and throughput of the main paths are measured and regressions are caught.

## R9. Many ChatGPT accounts scale horizontally

1. The user can connect several ChatGPT accounts. Each keeps its own sign-in, limits and connector; adding an account adds capacity for parallel work.
2. Turns are distributed across healthy accounts by load and limits; an account in cooldown or signed out takes no new turns while the others continue. No global lock or single component serializes work across accounts, and the loss of one account never stops the others.
3. Work that depends on an account (a retained conversation, a continuation, a compaction) stays on that account or is moved safely, never mixed.
4. With one account, everything works exactly as before; more accounts never change correctness, only capacity.
5. The product scales horizontally to thousands of users and thousands of accounts, where every account is used by the person it belongs to (for example each employee's own Enterprise seat): no shared bottleneck, no single machine or service whose failure stops others, and optional coordination that degrades to local operation when unreachable.
6. Capacity never comes from the ChatGPT Pro mode: it is retired from the catalog, the routes and setup, and Codex's `ultra` effort is never published. A thread still pinned to a retired Pro row gets one terminal error with one action (select Extra High).
7. Accounts are used within their provider's terms. OpenAI's Terms of Use (updated 16 January 2026) forbid making an account available to anyone else and circumventing rate limits or restrictions. The product therefore never shares one person's ChatGPT account with other people and never multiplies accounts to get around a limit; capacity beyond an account's limits comes from the routes built for it (native OpenAI models on the user's plan or API, and CLIProxyAPI providers under their own terms).

## R10. Ahead of every alternative

1. On every parameter users care about (reliability, correctness, latency and throughput, models and routes, Codex features kept, setup effort, self-healing, updates, privacy, platforms), the product is at least as good as the original projects (codex-chatgpt-web, CLIProxyAPI), their active forks, and comparable tools, and better where it matters to users.
2. The comparison is kept current in [competitive-analysis.md](competitive-analysis.md): each release cycle reviews new upstream releases, pull requests, forks and competing tools, and either ports, surpasses or records why not.
3. Approaches and technologies are re-evaluated as they change: releases of Codex, the runtime stack and other agent harnesses are watched automatically, and an approach is replaced when a better one serves the requirements.
4. Development never blocks on a decision: agents decide by the requirements, apply a conservative, reversible default where a person has not decided, record it, and continue.
