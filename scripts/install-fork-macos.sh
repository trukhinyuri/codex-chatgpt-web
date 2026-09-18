#!/bin/bash
# Build Codex Web GPT from the trukhinyuri fork and install it on macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/trukhinyuri/codex-chatgpt-web/fork-build/scripts/install-fork-macos.sh | bash
#
# Environment overrides:
#   REF=<branch>   fork branch to build (default: fork-build, which carries the fork's fixes)
#   SRC=<dir>      checkout location (default: ~/Personal/Sources/codex-chatgpt-web)
#   VERIFY=0       skip `bun run verify` (not recommended)
#
# Like the official installer, this script does not quit a running launcher: quit Codex Web GPT
# from its menu and run the command again. A package already built from the same commit is reused.
# It never touches ~/.codex or ~/.codex-chatgpt-web. The first app it replaces (normally the
# official release) is kept in ~/.cache/ccw-app-official.noindex for rollback; the .noindex suffix
# keeps that copy out of Spotlight and Launch Services.
set -euo pipefail

REPO_URL="https://github.com/trukhinyuri/codex-chatgpt-web.git"
UPSTREAM_URL="https://github.com/miuuyy/codex-chatgpt-web.git"
REF="${REF:-fork-build}"
SRC="${SRC:-$HOME/Personal/Sources/codex-chatgpt-web}"
VERIFY="${VERIFY:-1}"
APP="/Applications/Codex Web GPT.app"
KEEP="$HOME/.cache/ccw-app-official.noindex"

say() { printf '==> %s\n' "$*"; }
die() { printf 'install-fork-macos: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || die "macOS only"
command -v git >/dev/null 2>&1 || die "git is required"
command -v bun >/dev/null 2>&1 || die "Bun is required; the project pins its exact version in package.json"
case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

# Source checkout: clone once, then only fast-forward the requested fork branch.
if [ -d "$SRC/.git" ]; then
  origin="$(git -C "$SRC" remote get-url origin 2>/dev/null || true)"
  case "$origin" in
    *trukhinyuri/codex-chatgpt-web|*trukhinyuri/codex-chatgpt-web.git) ;;
    *) die "$SRC is not a checkout of the trukhinyuri fork (origin: ${origin:-none})" ;;
  esac
  [ -z "$(git -C "$SRC" status --porcelain)" ] || die "$SRC has uncommitted changes; commit or stash them first"
  git -C "$SRC" fetch --quiet origin
  if git -C "$SRC" show-ref --verify --quiet "refs/heads/$REF"; then
    git -C "$SRC" checkout --quiet "$REF"
    git -C "$SRC" merge --quiet --ff-only "origin/$REF" || die "local $REF has diverged from origin/$REF"
  else
    git -C "$SRC" checkout --quiet -b "$REF" --track "origin/$REF"
  fi
else
  mkdir -p "$(dirname "$SRC")"
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
[ "$WANT_BUN" = "$HAVE_BUN" ] || die "Bun $WANT_BUN is required, found $HAVE_BUN"

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
  bun install --frozen-lockfile
  (cd launcher && bun install --frozen-lockfile)
  if [ "$VERIFY" = 1 ]; then
    say "Running bun run verify (several minutes)"
    bun run verify
  else
    say "Skipping verification (VERIFY=0)"
  fi
  say "Packaging the macOS app"
  rm -f "$STAMP"
  bun run app:package
  ZIP="$(zip_path)"
  [ -n "$ZIP" ] || die "the macOS package was not produced"
  printf '%s\n' "$COMMIT" > "$STAMP"
fi

# Install exactly like the official installer: never replace a running launcher.
if pgrep -f "$APP/Contents/MacOS/Codex Web GPT" >/dev/null 2>&1; then
  die "quit Codex Web GPT from its menu, then run the same command again (the package will be reused)"
fi
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
ditto -x -k "$ZIP" "$STAGE"
NEW="$STAGE/Codex Web GPT.app"
[ -x "$NEW/Contents/MacOS/Codex Web GPT" ] || die "the package is incomplete: $ZIP"
if [ -d "$APP" ]; then
  if [ -d "$KEEP/Codex Web GPT.app" ]; then
    mv "$APP" "$HOME/.Trash/Codex Web GPT $(date +%Y%m%d-%H%M%S).app"
  else
    mkdir -p "$KEEP"
    mv "$APP" "$KEEP/"
    say "Previous app kept for rollback: $KEEP/Codex Web GPT.app"
  fi
fi
ditto "$NEW" "$APP"
say "Installed $APP from ${COMMIT:0:7}"
open -a "$APP"

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
