# 18.09.2026 — ChatGPT held the owner's account for suspicious activity

A user-visible incident: every ChatGPT Web turn on the affected account stopped working, and the
account itself lost features. This postmortem records what happened, the evidence, why it happened,
which requirements it broke and what now prevents it.

Upstream reports of the same failure, in codex-chatgpt-web:

| Issue | What it says |
| --- | --- |
| [#312](https://github.com/miuuyy/codex-chatgpt-web/issues/312), [#317](https://github.com/miuuyy/codex-chatgpt-web/issues/317) | the same "Suspicious activity" hold; in the comments it clears itself in about 24 hours **if the turns are not repeated**, and the triggers named are three or more simultaneous sessions held for a long time, a VPN, and intensive repeats |
| [#564](https://github.com/miuuyy/codex-chatgpt-web/issues/564) (18.09, v5.0.8) | "ChatGPT Web — Extra High consistently fails at prompt attachment while High works": after Extra High is selected the effort slider's maximum drops from 3 to 2, the Temporary Chat is lost, and attachment and send fail. The same happened here |
| [#562](https://github.com/miuuyy/codex-chatgpt-web/issues/562) | "Account-safety pacing, cooldowns and hard-stop guardrails" — the same shape as R3.3/R3.4 and R7.5: one pace per account, a hard stop on "Too many requests" and on the security banner, and no repeats during a cooldown |

## What happened

After a day of heavy parallel work through the bridge, ChatGPT showed the owner's account:

> Suspicious activity detected. It looks like someone else may be using your ChatGPT account.
> Please secure your account to regain access to all features

While the hold was in place:

- the model menu offered only Latest, GPT-5.6 Sol and GPT-5.5 — there was no Thinking effort row
  and no Pro, so the bridge could not select the mode a routed model demands;
- every turn therefore failed with `ChatGPT model controls are unavailable`, which the bridge
  treated as a retryable ChatGPT error and repeated;
- after the owner changed the account password, the Codex Native connector disappeared, so the Full
  harness had to be set up again.

## Evidence

Structural only; no prompt, answer or page text is reproduced here or kept in the repository.

| What | Where |
| --- | --- |
| Per-turn browser structure and checkpoints | `~/.codex-chatgpt-web/diagnostics/browser-turns/` |
| Launcher and bridge log | `~/Library/Application Support/Codex Web GPT/logs/launcher.jsonl` (read-only; never copied into this repository) |
| Owner's account of the load | up to 6 Codex goal threads at once, up to 5 browser tabs on one account, failed turns repeated about every 25 s, Pro mode with turns of about 265k tokens |

## Why it happened

1. **The product offered the mode that draws the most attention.** ChatGPT Web — Pro carried the
   largest single messages (up to 104k tokens, composer up to 1.6M characters) and the longest
   generations of any route. The traffic an account check reacts to is exactly this shape.
2. **A failing turn was repeated almost immediately.** Codex retries, and the bridge had no pause of
   its own between a ChatGPT-side failure and the next send. Six threads failing every 25 s produced
   a sustained burst from one account for hours.
3. **The bridge pressed an effort step the account no longer had.** When the slider's range
   shrank (upstream #564), the bridge kept asking for the missing Extra High step and failed every
   turn on it instead of taking the highest step the account still offered.
4. **The bridge could not recognise the hold.** `Suspicious activity detected` was not a signal the
   bridge knew, and a model menu without the expected controls was classified as
   `upstream_server_error` — retryable. The product kept sending into a check that counts requests.

## Requirements broken

- **R3.3 / R3.4** — load must be paced and provider limits and checks respected. Failed turns were
  repeated without any account-wide pause.
- **R3.5** — parallel sessions share one account correctly. They shared the account's risk without
  sharing any pacing state.
- **R2.1 / R2.3** — a failure the product cannot heal must be reported with exactly one action. The
  hold was reported as `ChatGPT model controls are unavailable. Reload ChatGPT and retry the task.`,
  which asks the user to do the product's work and to repeat the very thing that caused the hold.
- **R7.5** — the product reduces the risk of account restrictions by staying within limits, not by
  concealment. It had no mechanism that did so.

## Fixes in this change

1. **ChatGPT Web — Pro is retired.** The catalog, the routes, setup, the CLI flags
   (`--zero-risk-pro`, `--zero-risk-default`), the launcher's Zero Risk model toggle and the
   `proAvailable` capability are gone; Codex's `ultra` protocol effort is never published. Extra High
   is the top of the list. A thread still pinned to `chatgpt-web/pro` or `chatgpt-web/zero-risk-pro`
   receives one terminal error with one action: select ChatGPT Web — Extra High. A configuration or
   launcher state written by an older build still loads; the retired keys are dropped, never
   honoured, so nobody has to edit a file by hand (R1.2).
2. **A security-hold detector.** ChatGPT's account-hold banner, and a model or effort menu that no
   longer carries this account's controls, both stop automatic turns for the whole account. The hold
   has no expiry: it is cleared only after a person secures the account and signs in again. Queued
   turns end at once with one terminal error (`invalid_prompt`, so Codex does not retry it) naming
   one action. One structural diagnostic is written per hold — reason, opaque account key and time,
   with no page text, prompt or answer (R7.1).
3. **The selected effort degrades to what the account offers.** When the effort slider no longer
   exposes the step a routed mode needs, the turn runs on the highest step the account still has
   (Extra High → High), with one structural log line and a diagnostic checkpoint, instead of
   failing and repeating. An effort control with no usable range at all is still the account hold.
4. **Human-like pacing per account.** On top of the admission gate (account-wide cooldown, FIFO
   queue, 3-second opening spacing, heavy-phase lock), every failure ChatGPT itself ends a turn with
   now pauses the whole account before the next send: 60 s, doubling per consecutive failure to a
   ceiling of 5 minutes, shared by every session and every Codex thread on that account, and reset
   by one clean turn.

## Regression tests

| Test | What would fail without the fix |
| --- | --- |
| `tests/chatgpt-web-models.test.ts` | a Pro row in the catalog, a published `ultra` effort, or a Pro request answered with anything but the one-action terminal error |
| `tests/model-catalog.test.ts`, `tests/runtime-layout.test.ts` | a saved configuration re-publishing the retired rows |
| `tests/security-hold.test.ts` | the banner or the missing controls not recognised; a held account admitting a turn, expiring by itself, or losing the hold across a restart; a diagnostic carrying page text; a ChatGPT failure not pausing the account, or the pause not doubling to the 5-minute ceiling |
| `tests/chatgpt-session.test.ts` | an effort step the account stopped offering being pressed instead of degrading to the highest available step (upstream #564), or an unusable effort control not stopping the account |
| `tests/cli.test.ts` | the retired setup flags failing an older launcher's setup instead of being ignored |

## What ends a hold

Only a person: the hold has no timer, and nothing automatic clears it. It ends when a capability
probe reads this account's model and effort controls again — the launcher's session inspection,
which runs on Repair and on setup after the person has secured the account and signed in. Upstream
reports that ChatGPT's own flag lifts after about 24 hours **provided the turns stop**, which is
exactly what the hold guarantees; the product does not wait it out silently, because the person
needs to know why their work stopped.

## Still open

- The launcher shows the hold only through the turn's error text; a visible account state in the
  launcher belongs to the limits-and-queues work of reliability wave 2 (plan 2.3).
- Recovery still requires the person to secure the account and, if the password changed, to create
  the Codex Native connector again. Connector readiness is tracked in `fork/rel-connector`.
