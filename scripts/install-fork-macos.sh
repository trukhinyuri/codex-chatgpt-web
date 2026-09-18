#!/bin/bash
# Build Codex Web GPT from the trukhinyuri fork and install it on macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/trukhinyuri/codex-chatgpt-web/main/scripts/install-fork-macos.sh | bash
#
# Environment overrides:
#   REF=<branch>      branch to build (default: main)
#   SRC=<dir>         checkout to build from (default: ~/.codex-chatgpt-web-source, a clone this
#                     script and the launcher's updater manage; any local change there is discarded)
#   VERIFY=0          skip `bun run verify` (not recommended; the launcher's updater never skips it)
#   WAIT_FOR_IDLE=1   if the launcher is running, wait until Codex has no active ChatGPT Web turn,
#                     then quit the launcher and install (never interrupts running work)
#
# The script builds with the Bun version pinned in package.json, runs the full verification,
# packages the app, installs it into /Applications, checks that the launcher adopted the new
# runtime, and runs doctor. It never touches ~/.codex or ~/.codex-chatgpt-web. The replaced app is
# kept in ~/Library/Application Support/Codex Web GPT/rollback.noindex (the two newest builds, shared
# with the launcher's updater); the .noindex suffix keeps those copies out of Spotlight and Launch
# Services. If the new launcher does not report a healthy start, the previous app is restored.
# Roll back by hand with scripts/rollback-fork-macos.sh.
set -euo pipefail

REPO_URL="https://github.com/trukhinyuri/codex-chatgpt-web.git"
UPSTREAM_URL="https://github.com/miuuyy/codex-chatgpt-web.git"
MANAGED_SRC="$HOME/.codex-chatgpt-web-source"
REF="${REF:-main}"
SRC="${SRC:-$MANAGED_SRC}"
VERIFY="${VERIFY:-1}"
WAIT_FOR_IDLE="${WAIT_FOR_IDLE:-0}"
APP="/Applications/Codex Web GPT.app"
APP_PROC="$APP/Contents/MacOS/Codex Web GPT"
USER_DATA="$HOME/Library/Application Support/Codex Web GPT"
ROLLBACK_ROOT="$USER_DATA/rollback.noindex"
STARTUP_HEALTH="$USER_DATA/source-update-health.json"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-360}"
HEALTH_URL="http://127.0.0.1:17841/healthz"

say() { printf '==> %s\n' "$*"; }
die() { printf 'install-fork-macos: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || die "macOS only"
case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac
command -v git >/dev/null 2>&1 || die "git is required: install the Xcode Command Line Tools with 'xcode-select --install'"
command -v node >/dev/null 2>&1 || die "Node.js is required to package the app: install it, for example with 'brew install node'"
command -v bun >/dev/null 2>&1 || die "Bun is required: install the pinned version with: curl -fsSL https://bun.sh/install | bash -s bun-v1.4.0"

# One build at a time: the launcher's in-app updater takes the same lock.
LOCK="$SRC.lock"
mkdir -p "$(dirname "$SRC")"
if ! mkdir "$LOCK" 2>/dev/null; then
  owner="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null; then
    die "another install or launcher update is running (PID $owner)"
  fi
  rm -rf "$LOCK"
  mkdir "$LOCK" || die "could not acquire $LOCK"
fi
echo $$ > "$LOCK/pid"
STAGE=""
cleanup() { rm -rf "$LOCK"; if [ -n "$STAGE" ]; then rm -rf "$STAGE"; fi; }
trap cleanup EXIT

# Source checkout. The managed clone always matches origin/$REF exactly; a checkout you point SRC
# at is only fast-forwarded and must have no uncommitted changes.
if [ -d "$SRC/.git" ]; then
  origin="$(git -C "$SRC" remote get-url origin 2>/dev/null || true)"
  case "$origin" in
    *trukhinyuri/codex-chatgpt-web|*trukhinyuri/codex-chatgpt-web.git) ;;
    *) die "$SRC is not a checkout of the trukhinyuri fork (origin: ${origin:-none})" ;;
  esac
  git -C "$SRC" fetch --quiet origin
  if [ "$SRC" = "$MANAGED_SRC" ]; then
    git -C "$SRC" checkout --quiet --force -B "$REF" "origin/$REF"
    git -C "$SRC" reset --quiet --hard "origin/$REF"
    git -C "$SRC" clean --quiet -fd
  else
    [ -z "$(git -C "$SRC" status --porcelain --untracked-files=no)" ] || die "$SRC has uncommitted changes; commit or stash them first"
    if git -C "$SRC" show-ref --verify --quiet "refs/heads/$REF"; then
      git -C "$SRC" checkout --quiet "$REF"
      git -C "$SRC" merge --quiet --ff-only "origin/$REF" || die "local $REF has diverged from origin/$REF"
    else
      git -C "$SRC" checkout --quiet -b "$REF" --track "origin/$REF"
    fi
  fi
else
  [ ! -e "$SRC" ] || [ -z "$(ls -A "$SRC")" ] || die "$SRC exists but is not a Git checkout; move it away or set SRC"
  git clone --quiet --branch "$REF" "$REPO_URL" "$SRC"
fi
git -C "$SRC" remote get-url upstream >/dev/null 2>&1 || git -C "$SRC" remote add upstream "$UPSTREAM_URL"
cd "$SRC"
COMMIT="$(git rev-parse HEAD)"
say "Source: $REF @ ${COMMIT:0:7} ($(git log -1 --format=%s))"

# The packaged app embeds the Bun that runs the build, so it must be the pinned version.
WANT_BUN="$(sed -n 's/.*"packageManager": *"bun@\([0-9][0-9.]*\)".*/\1/p' package.json)"
HAVE_BUN="$(bun --version)"
[ -n "$WANT_BUN" ] || die "cannot read the pinned Bun version from package.json"
[ "$WANT_BUN" = "$HAVE_BUN" ] || die "Bun $WANT_BUN is required, found $HAVE_BUN; install it with: curl -fsSL https://bun.sh/install | bash -s bun-v$WANT_BUN"

# Build: verify, then package. Reuse a package built from this exact commit.
STAMP="launcher/artifacts/.built-commit"
zip_path() {
  local newest="" candidate
  for candidate in launcher/artifacts/codex-web-gpt-*-mac-"$ARCH".zip; do
    [ -f "$candidate" ] || continue
    if [ -z "$newest" ] || [ "$candidate" -nt "$newest" ]; then newest="$candidate"; fi
  done
  printf '%s' "$newest"
}
ZIP="$(zip_path)"
if [ -n "$ZIP" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$COMMIT" ]; then
  say "Reusing the package built from ${COMMIT:0:7}: $ZIP"
else
  say "Installing dependencies"
  # Build at low CPU priority so running ChatGPT turns keep a responsive browser.
  nice -n 15 bun install --frozen-lockfile
  (cd launcher && nice -n 15 bun install --frozen-lockfile)
  if [ "$VERIFY" = 1 ]; then
    say "Running bun run verify (all tests, several minutes)"
    nice -n 15 bun run verify
  else
    say "Skipping verification (VERIFY=0)"
  fi
  say "Packaging the macOS app"
  rm -f "$STAMP"
  nice -n 15 bun run app:package
  ZIP="$(zip_path)"
  [ -n "$ZIP" ] || die "the macOS package was not produced"
  printf '%s\n' "$COMMIT" > "$STAMP"
fi

# Install exactly like the official installer: never replace a running launcher, and never cancel
# work to do it.
launcher_running() { pgrep -f "$APP_PROC" >/dev/null 2>&1; }
active_turns() {
  local health http browser
  health="$(curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null)" || { echo 0; return; }
  http="$(printf '%s' "$health" | plutil -extract active_http_turns raw -o - - 2>/dev/null || echo 0)"
  browser="$(printf '%s' "$health" | plutil -extract active_browser_turns raw -o - - 2>/dev/null || echo 0)"
  echo $(( http + browser ))
}
if launcher_running; then
  [ "$WAIT_FOR_IDLE" = 1 ] || die "quit Codex Web GPT from its menu, or rerun with WAIT_FOR_IDLE=1 (the package will be reused)"
  say "Waiting until Codex has no active ChatGPT Web turn for 60 seconds"
  quiet=0
  while [ "$quiet" -lt 60 ]; do
    if [ "$(active_turns)" = 0 ]; then quiet=$((quiet + 5)); else quiet=0; fi
    sleep 5
  done
  say "Quitting Codex Web GPT"
  osascript -e 'tell application "Codex Web GPT" to quit' >/dev/null 2>&1 || true
  for _ in $(seq 1 60); do launcher_running || break; sleep 1; done
  launcher_running && die "Codex Web GPT did not quit; quit it from its menu and rerun"
fi
STAGE="$(mktemp -d)"
ditto -x -k "$ZIP" "$STAGE"
NEW="$STAGE/Codex Web GPT.app"
[ -x "$NEW/Contents/MacOS/Codex Web GPT" ] || die "the package is incomplete: $ZIP"
plist_commit() { plutil -extract CodexWebGptSourceCommit raw -o - "$1/Contents/Info.plist" 2>/dev/null || true; }
NEW_STAMP="$(plist_commit "$NEW")"
SAVED=""
if [ -d "$APP" ]; then
  OLD_COMMIT="$(plist_commit "$APP")"
  SAVED="$ROLLBACK_ROOT/$(date -u +%Y%m%dT%H%M%SZ)-${OLD_COMMIT:-unknown}"
  SAVED="${SAVED:0:$(( ${#ROLLBACK_ROOT} + 30 ))}"
  mkdir -p "$SAVED"
  chmod 700 "$USER_DATA" "$ROLLBACK_ROOT" 2>/dev/null || true
  mv "$APP" "$SAVED/"
  printf '{"version":1,"commit":"%s","replacedBy":"%s","savedAt":"%s","source":"installer"}\n' \
    "${OLD_COMMIT:-}" "$COMMIT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$SAVED/meta.json"
  say "Previous app kept for rollback: $SAVED"
fi
ditto "$NEW" "$APP"
say "Installed $APP from ${COMMIT:0:7}"
rm -f "$STARTUP_HEALTH"
open -a "$APP"

# Builds that report their start (all builds of this fork since the automatic updater) must report a
# healthy one; otherwise the previous app goes back into place, exactly as the in-app updater does.
restore_previous() {
  say "Restoring the previous app: $1"
  osascript -e 'tell application "Codex Web GPT" to quit' >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do launcher_running || break; sleep 1; done
  pkill -f "$APP_PROC" >/dev/null 2>&1 || true
  if [ -n "$SAVED" ] && [ -d "$SAVED/Codex Web GPT.app" ]; then
    rm -rf "$APP"
    mv "$SAVED/Codex Web GPT.app" "$APP"
    rm -rf "$SAVED"
    open -a "$APP"
    die "the new build did not start cleanly ($1); the previous app was restored"
  fi
  die "the new build did not start cleanly ($1) and there was no previous app to restore"
}
if [ "$NEW_STAMP" = "$COMMIT" ]; then
  say "Waiting for the launcher to report a healthy start"
  status=""
  for _ in $(seq 1 "$HEALTH_TIMEOUT"); do
    if [ -f "$STARTUP_HEALTH" ] && [ "$(plutil -extract commit raw -o - "$STARTUP_HEALTH" 2>/dev/null)" = "$COMMIT" ]; then
      status="$(plutil -extract status raw -o - "$STARTUP_HEALTH" 2>/dev/null || true)"
      [ "$status" = healthy ] || [ "$status" = unhealthy ] && break
    fi
    sleep 1
  done
  case "$status" in
    healthy) say "The launcher started healthy" ;;
    unhealthy) restore_previous "$(plutil -extract reason raw -o - "$STARTUP_HEALTH" 2>/dev/null || echo unknown)" ;;
    *) restore_previous "no healthy start within ${HEALTH_TIMEOUT} s" ;;
  esac
fi
if [ -d "$ROLLBACK_ROOT" ]; then
  # Keep the two newest builds, like the in-app updater.
  find "$ROLLBACK_ROOT" -mindepth 1 -maxdepth 1 -type d -name '????????T??????Z-*' | sort -r | tail -n +3 |
    while IFS= read -r old; do rm -rf "$old"; done
fi

# Read back: the launcher must adopt the new runtime, then report its health.
VERSION="$(defaults read "$APP/Contents/Info" CFBundleShortVersionString)"
WANT="$(shasum -a 256 "$APP/Contents/Resources/runtime/app/cli.js" | cut -d' ' -f1)"
RUNTIME="$HOME/.codex-chatgpt-web/versions/$VERSION-darwin-$ARCH/app/cli.js"
HAVE=""
for _ in $(seq 1 60); do
  HAVE="$(shasum -a 256 "$RUNTIME" 2>/dev/null | cut -d' ' -f1 || true)"
  [ "$HAVE" = "$WANT" ] && break
  sleep 2
done
[ "$HAVE" = "$WANT" ] || die "the launcher did not adopt the new runtime at $RUNTIME"
say "Runtime in use matches the package (${WANT:0:12})"

if [ -f "$HOME/.codex-chatgpt-web/config.json" ]; then
  for _ in $(seq 1 45); do
    lsof -nP -iTCP:17841 -sTCP:LISTEN >/dev/null 2>&1 && break
    sleep 2
  done
  say "Doctor"
  "$APP/Contents/Resources/runtime/bin/codex-chatgpt-web" doctor || true
else
  say "Not set up yet: sign in to ChatGPT in the launcher, run the browser smoke test, then Install models"
fi
say "RESULT installed commit=$COMMIT runtime=${WANT:0:12}"
