#!/bin/bash
# Put the previous build of Codex Superpower back into /Applications (the app keeps its file name,
# Codex Web GPT.app, and its data folder).
#
#   curl -fsSL https://raw.githubusercontent.com/trukhinyuri/codex-superpower/main/scripts/rollback-fork-macos.sh | bash
#
# The launcher's updater and the installer keep the two builds they replaced in
# ~/Library/Application Support/Codex Web GPT/rollback.noindex. This script restores the newest one
# (or the one named by ENTRY), keeps the current build there so you can roll forward again, and tells
# automatic updates to skip the commit you rolled back from until main moves on.
#
# Environment overrides:
#   LIST=1      only list the stored builds
#   ENTRY=<name> restore this stored build instead of the newest
#   NOW=1       do not wait for Codex to become idle (running ChatGPT Web turns are cancelled)
set -euo pipefail

APP="/Applications/Codex Web GPT.app"
APP_PROC="$APP/Contents/MacOS/Codex Web GPT"
USER_DATA="$HOME/Library/Application Support/Codex Web GPT"
ROLLBACK_ROOT="$USER_DATA/rollback.noindex"
STATE="$USER_DATA/source-update-state.json"
HEALTH_URL="http://127.0.0.1:17841/healthz"

say() { printf '==> %s\n' "$*"; }
die() { printf 'rollback-fork-macos: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || die "macOS only"
entries() {
  [ -d "$ROLLBACK_ROOT" ] || return 0
  find "$ROLLBACK_ROOT" -mindepth 1 -maxdepth 1 -type d -name '????????T??????Z-*' -exec basename {} \; | sort -r
}
plist_commit() { plutil -extract CodexWebGptSourceCommit raw -o - "$1/Contents/Info.plist" 2>/dev/null || true; }

if [ "${LIST:-0}" = 1 ]; then
  say "Installed: $(plist_commit "$APP")"
  entries | while IFS= read -r name; do
    printf '    %s  commit=%s\n' "$name" "$(plist_commit "$ROLLBACK_ROOT/$name/Codex Web GPT.app")"
  done
  exit 0
fi

ENTRY="${ENTRY:-$(entries | head -n 1)}"
[ -n "$ENTRY" ] || die "no previous build is stored in $ROLLBACK_ROOT"
SOURCE="$ROLLBACK_ROOT/$ENTRY/Codex Web GPT.app"
[ -x "$SOURCE/Contents/MacOS/Codex Web GPT" ] || die "$ENTRY does not contain a complete app"
CURRENT_COMMIT="$(plist_commit "$APP")"
TARGET_COMMIT="$(plist_commit "$SOURCE")"
say "Rolling back from ${CURRENT_COMMIT:-an unstamped build} to ${TARGET_COMMIT:-an unstamped build} ($ENTRY)"

launcher_running() { pgrep -f "$APP_PROC" >/dev/null 2>&1; }
active_turns() {
  local health http browser
  health="$(curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null)" || { echo 0; return; }
  http="$(printf '%s' "$health" | plutil -extract active_http_turns raw -o - - 2>/dev/null || echo 0)"
  browser="$(printf '%s' "$health" | plutil -extract active_browser_turns raw -o - - 2>/dev/null || echo 0)"
  echo $(( http + browser ))
}
if launcher_running; then
  if [ "${NOW:-0}" != 1 ]; then
    say "Waiting until Codex has no active ChatGPT Web turn for 30 seconds (NOW=1 skips this)"
    quiet=0
    while [ "$quiet" -lt 30 ]; do
      if [ "$(active_turns)" = 0 ]; then quiet=$((quiet + 5)); else quiet=0; fi
      sleep 5
    done
  fi
  say "Quitting Codex Superpower"
  if [ "${NOW:-0}" = 1 ]; then
    # A normal quit asks first while turns run; NOW=1 means stop them, which SIGTERM does.
    pkill -TERM -f "$APP_PROC" >/dev/null 2>&1 || true
  else
    # By bundle id, never by name: an older copy that LaunchServices still knows as "Codex Web GPT"
    # (a backup, a download) would be the one AppleScript opens and quits.
    osascript -e 'tell application id "dev.codexwebgpt.launcher" to quit' >/dev/null 2>&1 || true
  fi
  for _ in $(seq 1 60); do launcher_running || break; sleep 1; done
  launcher_running && die "Codex Superpower did not quit; quit it from its menu and rerun"
fi

# Keep the build we leave, so rolling forward is the same operation.
if [ -d "$APP" ]; then
  KEPT="$ROLLBACK_ROOT/$(date -u +%Y%m%dT%H%M%SZ)-${CURRENT_COMMIT:-unknown}"
  KEPT="${KEPT:0:$(( ${#ROLLBACK_ROOT} + 30 ))}"
  mkdir -p "$KEPT"
  mv "$APP" "$KEPT/"
  printf '{"version":1,"commit":"%s","savedAt":"%s","source":"rollback"}\n' \
    "${CURRENT_COMMIT:-}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$KEPT/meta.json"
fi
mv "$SOURCE" "$APP"
rm -rf "${ROLLBACK_ROOT:?}/$ENTRY"

# Automatic updates skip the commit we rolled back from; a newer main is offered again as usual.
if [[ "$CURRENT_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  osascript -l JavaScript - "$STATE" "$CURRENT_COMMIT" >/dev/null <<'JXA'
ObjC.import("Foundation");
function run(argv) {
  const [file, commit] = argv;
  let state = { version: 1, failedCommits: {}, lastResult: null };
  const text = $.NSString.stringWithContentsOfFileEncodingError(file, $.NSUTF8StringEncoding, null);
  if (text) {
    try {
      const parsed = JSON.parse(text.js);
      if (parsed && parsed.version === 1 && parsed.failedCommits) state = parsed;
    } catch (error) {}
  }
  const at = new Date().toISOString();
  state.failedCommits[commit] = { at, stage: "rolled-back-by-user", reason: "rolled back with rollback-fork-macos.sh" };
  state.lastResult = { commit, result: "rolled-back", at, stage: "rolled-back-by-user", reason: null };
  $.NSString.alloc.initWithUTF8String(JSON.stringify(state, null, 2) + "\n")
    .writeToFileAtomicallyEncodingError(file, true, $.NSUTF8StringEncoding, null);
}
JXA
  chmod 600 "$STATE" 2>/dev/null || true
fi
open -a "$APP"
say "RESULT rolled-back commit=${TARGET_COMMIT:-unknown} from=${CURRENT_COMMIT:-unknown}"
