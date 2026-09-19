# Updating without the macOS "App Management" permission

**Requirements:** R4.6 (the first install is the only manual step), R4.1–R4.5 (an update installs only
after a green build and rolls back), R1.2 (nothing needs maintenance after the first install), R3.1
(no automatic action interrupts a running turn), R7.5 (the product never evades a platform's
protective measures).

**Status:** the shape of the fix is implemented and tested; the last step — a signing certificate —
is the owner's decision and is stated at the end with exactly what it buys.

## 1. What happens today

On a Mac running macOS Ventura or later the automatic update stops at the system's **App
Management** request (Privacy & Security → App Management), which the user has to grant by hand.
That is a manual step after the first install, so R4.6 and R1.2 are broken.

### Who replaces the bundle, and with which identity

| Fact | Evidence |
| --- | --- |
| The installed app is ad-hoc signed: no Team ID, and its designated requirement is the hash of that one build | `codesign -dv --verbose=4 "/Applications/Codex Web GPT.app"` → `Signature=adhoc`, `TeamIdentifier=not set`; `codesign -d -r-` → `designated => cdhash H"4dddbe05…"` |
| Packaging signs ad-hoc unless a certificate is configured | `launcher/scripts/package.cjs`: `builderArgs.push("--config.mac.identity=-")` when neither `CSC_LINK` nor `CSC_NAME` is set |
| Until this change, the process that replaced the bundle was **Bun from the user's home**, not the app | `launcher/electron/main.cjs` passed `runtimeExecutable` = `~/.codex-chatgpt-web/versions/<version>-darwin-<arch>/runtime/bun`; `source-update.cjs` spawned the worker with it |
| That Bun binary has no bundle and no Team ID either | `codesign -dv` on it → `Identifier=bun`, `Signature=adhoc`, `linker-signed`, `TeamIdentifier=not set`, `Sealed Resources=none` |
| The worker acts **after** the launcher has exited (it waits for the parent PID), so the app is no longer there to be the responsible process | `launcher/electron/source-update-worker.cjs`, `waitForExit(job.parentPid, …)` before any change |

So the program that asked macOS to replace `/Applications/Codex Web GPT.app` was a bundle-less,
ad-hoc binary living under a path that changes with every version, running after its parent app had
quit. Two consequences follow from Apple's rules below: the request can never fall under the
documented exemption, and a permission granted once would not survive the next version, because the
binary's path (and its signature) changes with each build.

### Apple's rule

Apple states the rule in WWDC22 session 10096, "What's new in privacy" — still the only
detailed official statement:

> "Apps validly signed by the same developer account or team will continue to be able to update each
> other."

and

> "macOS will block the modification and notify the user that an app wants to manage other apps"

when the modifying code is neither signed by the same team nor allowed by an
`NSUpdateSecurityPolicy`.
<https://developer.apple.com/videos/play/wwdc2022/10096/>

The escape hatch Apple documents is keyed to the same identity:
`NSUpdateSecurityPolicy` → `AllowProcesses` is "a dictionary mapping **team identifiers** to an array
of signing identifiers".
<https://developer.apple.com/documentation/bundleresources/information-property-list/nsupdatesecuritypolicy>

Two more facts matter for this project:

- TCC decides by the **responsible process**, and a child process inherits its parent's
  responsibility unless it explicitly disclaims it (private
  `responsibility_spawnattrs_setdisclaim()`).
  <https://www.qt.io/blog/the-curious-case-of-the-responsible-process> (reported, not Apple
  documentation)
- A plain executable with no bundle cannot even be given App Management: Apple DTS, on a TCC record
  for a bare binary — "No bundle or no bundle ID found for record".
  <https://developer.apple.com/forums/thread/813989>

### Conclusion about the cause

With an ad-hoc signature there is no team identifier, so neither the "same developer account or
team" exemption nor `NSUpdateSecurityPolicy` can ever apply. On top of that, the project handed the
job to a binary that macOS cannot attribute to this app at all. The first part is a property of the
signature (owner's decision); the second was a property of our code, and is what this change fixes.

Not verified (stated as such): Apple has published no statement on whether an **ad-hoc signed,
non-notarized** bundle is itself a protected target. Apple's own wording ties the Ventura change to
notarized apps ("Gatekeeper will now check the integrity of all notarized apps"), and a
well-researched community write-up concludes the protection covers notarized apps
(<https://lapcatsoftware.com/articles/AppManagement.html>). The owner's observation on a real Mac is
that the request does appear, so the question of *which* operation triggers it is settled by
evidence from an installation, not by argument — which is why this change also makes the updater
record the refusal instead of failing with a generic message (section 3).

## 2. What the other updaters do

- **Sparkle** puts the code that replaces the bundle *inside the bundle*: `Autoupdate` /
  `Updater.app`, and `Installer.xpc` for sandboxed apps, all signed with the app's own identity, and
  since 2.0 they run as a submitted launchd agent with XPC.
  <https://sparkle-project.org/documentation/sandboxing/>,
  <https://github.com/sparkle-project/Sparkle/blob/2.x/CHANGELOG>
  The project's own summary of the Ventura change: the prompt "only affects developers that develop
  products that update other developer's apps".
  <https://github.com/sparkle-project/Sparkle/discussions/2154>
  Sparkle 2.6.4 takes its fast APFS atomic-swap path **only when the Team IDs match**, precisely to
  avoid "app replacement issues from OS".
  <https://github.com/sparkle-project/Sparkle/pull/2516>
- **Squirrel.Mac / ShipIt** (what electron-updater uses on macOS): `ShipIt` ships inside
  `Squirrel.framework/Resources` in the app bundle — again the app's own signature — and finishes the
  replacement after the app exits. Squirrel.Mac requires a valid signature for automatic updates at
  all. <https://github.com/Squirrel/Squirrel.Mac>,
  <https://www.electron.build/docs/features/auto-update/>

The shared shape: **the bundle is replaced by a process that is part of that bundle.** No project
found solves it by moving the app to `~/Applications`; every documented discussion of
`~/Applications` is about POSIX write permission and the admin password, not about TCC
(<https://github.com/electron-userland/electron-builder/issues/1093>), and an Apple DTS thread shows
the block happening outside `/Applications` as well, on a USB volume, with matching Team IDs
(<https://developer.apple.com/forums/thread/721002>). Moving the app is therefore **not** a fix, and
this plan does not propose it.

## 3. What this change does

1. **The bundle replaces itself.** `updateWorkerCommand()` in `launcher/electron/source-update.cjs`
   starts the update worker from the installed bundle's own executable
   (`…/Codex Web GPT.app/Contents/MacOS/Codex Web GPT`) with `ELECTRON_RUN_AS_NODE=1`, instead of
   Bun from the user's home. This is the Sparkle/ShipIt shape:
   - the process that changes the bundle is part of it, at a stable path, with a stable bundle id
     (`dev.codexwebgpt.launcher`) — not a versioned, bundle-less binary macOS cannot even record;
   - the detached child inherits the app's TCC responsibility, so whatever macOS decides, it decides
     about *this app*;
   - the moment a Developer ID certificate exists, Apple's documented same-team exemption applies
     with **no further code change**.
   `ELECTRON_RUN_AS_NODE` makes the app's executable behave as Node: no window, no single-instance
   lock, nothing of the user's session touched. Checked against the installed build:
   `ELECTRON_RUN_AS_NODE=1 "/Applications/Codex Web GPT.app/Contents/MacOS/Codex Web GPT" -e …`
   printed `node 24.18.0` with `argv[0]` equal to the bundle's executable. A running executable survives the rename of its own
   file on macOS, and the build it runs from is kept in the rollback store, so the worker finishes
   the swap and the rollback from the copy it started in.
2. **An installation that may not replace its bundle never quits.** Before the launcher hands over
   and exits, `probeBundleWritable()` writes and removes one file inside its own bundle — the exact
   operation macOS protects — and one beside it, in the folder the two renames of the swap happen in. On a refusal (`EPERM`, `EACCES`) the update does not start: the
   launcher keeps running, the verified build stays staged for the next window, the commit is *not*
   remembered as failed (nothing is wrong with it), and the maintainer gets a problem report with
   the code `bundle-not-writable`. Before this change the launcher quit first and the worker failed
   afterwards, which is a half-finished update and a silent stall against R4.1.
3. **The refusal has its own code.** `classifyUpdateFailure()` maps `EPERM` / `EACCES` /
   "Operation not permitted" to `bundle-not-writable` instead of `stage-failed` or `other`, so an
   installation blocked by App Management is distinguishable from a broken build in the problem
   reports and in `source-update-state.json` — the evidence R2.4 needs to close this loop
   automatically.
4. **The installer and the rollback script no longer confuse the worker with the app.** Because the
   worker now runs from the app's executable, `pgrep -f "$APP_PROC"` matches it;
   `scripts/install-fork-macos.sh` and `scripts/rollback-fork-macos.sh` filter it out and no longer
   `pkill` every process under that path, which would have killed a worker mid-swap.

Nothing here evades a macOS protection (R7.5): the product asks the system in the shape the system
documents, and when the system refuses, it stops and says so instead of working around it.

## 4. What is tested, and what is not

Tests (`launcher/tests/source-update.test.cjs`, `problem-report.test.cjs`,
`packaging-contract.test.cjs`):

- the worker command is the bundle's own executable with `ELECTRON_RUN_AS_NODE=1`, and falls back to
  the runtime executable when the launcher does not run from a bundle;
- the controller starts the worker with that command;
- the probe reports `writable: true` on a normal bundle and a refusal code on one that cannot be
  written (a directory with mode 500 produces the same `EACCES`/`EPERM` shape as the TCC refusal),
  and leaves nothing inside the bundle;
- a refused install keeps the staged build, spawns nothing, quits nothing, warns and reports
  `bundle-not-writable`;
- the classifier maps permission refusals to `bundle-not-writable`;
- the two shell scripts ignore the worker and still parse.

**NOT_CHECKED, and why:**

- **A real "update with no dialog" on a clean Mac.** It cannot be proven here: this Mac's
  `/Applications` must not be touched by this work, and a GitHub `macos-15` runner cannot decide the
  question either — TCC prompts have nobody to answer them there, and the runner's own privacy
  configuration is not a user's. The honest end-to-end proof is the next release on the owner's Mac:
  the update either installs unattended, or `source-update-state.json` now names
  `bundle-not-writable` and a problem report says so. That is the first measurement that separates
  the two open hypotheses (an ad-hoc bundle is protected as a target, versus the prompt came from
  the terminal-run installer).
- **Whether an ad-hoc, non-notarized bundle is a protected target at all.** No Apple statement found.
- **How TCC picks the responsible process for a detached child of an Electron app.** Apple does not
  document it; the inheritance rule is reported, not official.

## 5. What a Developer ID certificate would change (owner's decision)

The project already accepts one: `launcher/scripts/package.cjs` signs ad-hoc only when neither
`CSC_LINK` nor `CSC_NAME` is present, so a certificate needs no code change, only the secret and a
notarization step.

**It buys:**

- a Team ID, and therefore Apple's documented exemption — the app and the worker inside it may
  replace the app's bundle with no permission and no prompt, on every Mac
  (<https://developer.apple.com/videos/play/wwdc2022/10096/>). Together with change 1 above this
  closes R4.6 completely;
- a stable designated requirement: every privacy permission the user grants (screen recording,
  automation, and App Management itself if it is ever asked) survives an update instead of resetting
  with each build — this is the "Signing" item already in [roadmap.md](../roadmap.md);
- notarization, so the app stops looking unidentified at first launch.

**It does not buy:** the right to modify *other* developers' apps, and it does not help if the
executable's path changes between releases (ours does not).

**Until then** the product behaves correctly rather than well: it never half-installs, never
interrupts a turn, keeps the verified build ready, and reports the exact reason. If the owner's next
release still meets the request, the remaining choice is the certificate — there is no supported way
to replace a bundle without either the same Team ID or the user's consent, and the alternatives
(moving to `~/Applications`, writing the `com.apple.macl` attribute Finder writes) are either
unsupported by any source or an evasion of a protection, which R7.5 forbids.
