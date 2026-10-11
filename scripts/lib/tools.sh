#!/usr/bin/env bash
#
# lib/tools.sh — what this project needs on a machine, in one table.
#
# Sourced, never run. `scripts/tools.sh` is the command.
#
# ## Why a table rather than a README section
#
# Setting up a laptop happens once; the *check* does not. A deploy or a
# `wrangler secret put` that stops half way for a missing or signed-out tool
# leaves a Worker with some of its secrets. Knowing the answer before starting
# is worth more here than the install is.
#
# So the install half is the convenience and the check half is the point.
#
# ## Two things it deliberately will not do
#
# **It never installs Homebrew.** That means piping a script from the internet
# into a shell, which is the one habit this repo would refuse anywhere else;
# there is no reason it becomes acceptable because it is convenient. Missing
# brew prints the command and stops.
#
# **It never signs anything in.** `clasp login` and `wrangler login` open a
# browser and want a human. It reports whether each is authenticated, which is
# the part that is actually easy to get wrong.
#
# Written for bash 3.2, because that is what `/bin/bash` is on macOS and a
# script that only runs under Homebrew's bash is a script that fails on exactly
# the fresh machine it exists for. No associative arrays, no `mapfile`.

# name | kind | installer | why we need it
#
# installer is one of:
#   brew:<formula>   a Homebrew formula
#   cask:<name>      a Homebrew cask
#   bootstrap        installed per-project by `npm run bootstrap`, never globally
#   playwright       a browser the locked Playwright downloads
#   manual           a human has to do it
TOOLS_TABLE='
brew|required|manual|installs everything else on macOS
node|required|brew:node|clasp, vitest, vite and wrangler all run on it
npm|required|brew:node|comes with node
git|required|manual|ships with the Xcode command line tools
openssl|required|brew:openssl|generates SESSION_KEY
clasp|required|bootstrap|pushes src/ to Apps Script and moves the consent redirect
wrangler|required|bootstrap|deploys the Worker and writes its secrets
webkit|optional|playwright|the browser npm run test:e2e drives
gh|optional|brew:gh|opens pull requests
jq|optional|brew:jq|reads JSON in scripts and by hand
rsvg-convert|optional|brew:librsvg|regenerates apple-touch-icon.png from icon.svg
'

# The repository root, and the `web/` under it. Set by the caller so this file
# works from anywhere; defaults to the checkout this lives in.
TOOLS_ROOT_DIR="${TOOLS_ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
TOOLS_WEB_DIR="${TOOLS_WEB_DIR:-${TOOLS_ROOT_DIR}/web}"

# `clasp` and `wrangler` are deliberately project-local rather than global:
# each version is pinned in a lockfile, so every machine and CI get the same
# one. A globally installed copy is a version nobody agreed on, which is how a
# deploy behaves differently on one laptop.
tool_path() {
  case "$1" in
    clasp) echo "${TOOLS_ROOT_DIR}/node_modules/.bin/clasp" ;;
    playwright) echo "${TOOLS_ROOT_DIR}/node_modules/.bin/playwright" ;;
    wrangler) echo "${TOOLS_WEB_DIR}/node_modules/.bin/wrangler" ;;
  esac
}

# Where the locked Playwright expects its WebKit. The directory is named for
# the browser revision, so a WebKit left behind by an older Playwright is
# correctly not this one.
webkit_location() {
  "$(tool_path playwright)" install --dry-run webkit 2>/dev/null |
    sed -n 's/^ *Install location: *//p' | head -1
}

tool_present() {
  local location
  case "$1" in
    clasp|wrangler) [ -x "$(tool_path "$1")" ] ;;
    webkit)
      [ -x "$(tool_path playwright)" ] || return 1
      location="$(webkit_location)"
      [ -n "$location" ] && [ -d "$location" ]
      ;;
    *) command -v "$1" >/dev/null 2>&1 ;;
  esac
}

tool_version() {
  case "$1" in
    clasp|wrangler) "$(tool_path "$1")" --version 2>/dev/null | tail -1 ;;
    webkit) basename "$(webkit_location)" ;;
    node|npm) "$1" --version 2>/dev/null ;;
    openssl) openssl version 2>/dev/null | cut -d' ' -f1-2 ;;
    git) git --version 2>/dev/null | sed 's/git version //' ;;
    gh) gh --version 2>/dev/null | head -1 | sed 's/gh version //' | cut -d' ' -f1 ;;
    brew) brew --version 2>/dev/null | head -1 | sed 's/Homebrew //' ;;
    *) "$1" --version 2>/dev/null | head -1 ;;
  esac
}

# The oldest Node the project installs on, as `engines` in the root
# `package.json` states it. Read from there so the check cannot drift from what
# `engine-strict` enforces at install time.
node_floor() {
  sed -n 's/.*"node": *">=\([0-9][0-9.]*\)".*/\1/p' "${TOOLS_ROOT_DIR}/package.json" | head -1
}

# version_at_least <version> <floor> — dotted numbers, compared field by field.
# A leading `v` is ignored and a missing field counts as zero. The two dots
# appended are what make it missing: `cut` hands back the whole line when the
# delimiter is not in it, so a bare "22" would otherwise be its own minor.
version_at_least() {
  local have="${1#v}" want="${2#v}" h w i
  for i in 1 2 3; do
    h="$(printf '%s..' "$have" | cut -d. -f"$i")"
    w="$(printf '%s..' "$want" | cut -d. -f"$i")"
    h="${h:-0}"
    w="${w:-0}"
    [ "$h" -gt "$w" ] && return 0
    [ "$h" -lt "$w" ] && return 1
  done
  return 0
}

# A Node that is on the machine and older than the floor. Present-and-old is
# its own state: installing cannot fix it, and every `npm ci` refuses to run on
# it once `engine-strict` is set.
node_too_old() {
  tool_present node && ! version_at_least "$(node --version)" "$(node_floor)"
}

# Walk the table, calling back for each row. Keeps the parsing in one place
# rather than repeating the same `while IFS` in check and install.
tools_each() {
  local callback="$1" name kind installer why
  printf '%s\n' "$TOOLS_TABLE" | while IFS='|' read -r name kind installer why; do
    [ -n "$name" ] || continue
    # The loop's stdin is the table, and an installer that reads a line of it
    # would end the walk early with the remaining rows never visited.
    "$callback" "$name" "$kind" "$installer" "$why" </dev/null
  done
}

# ---------------------------------------------------------------------------
# Checking
# ---------------------------------------------------------------------------

_tools_report_row() {
  local name="$1" kind="$2" installer="$3" why="$4"

  if [ "$name" = node ] && node_too_old; then
    printf '  %-14s %-9s %s\n' "$name" "TOO OLD" "$(node --version), and this needs $(node_floor) or later"
    : >"$TOOLS_MISSING_MARKER"
  elif tool_present "$name"; then
    printf '  %-14s %-9s %s\n' "$name" "ok" "$(tool_version "$name")"
  elif [ "$kind" = required ]; then
    printf '  %-14s %-9s %s\n' "$name" "MISSING" "$why"
    # A subshell per row means a variable cannot carry the verdict out, so the
    # marker is a file. Cheap, and it survives the pipe that `tools_each` uses.
    : >"$TOOLS_MISSING_MARKER"
  else
    printf '  %-14s %-9s %s\n' "$name" "-" "optional: $why"
  fi
}

# Prints one line per tool. Returns non-zero if a *required* one is absent.
tools_check() {
  # A full template with its X's: GNU `mktemp -t` refuses one without them and
  # prints nothing, which left the marker's path empty and the check passing.
  TOOLS_MISSING_MARKER="$(mktemp "${TMPDIR:-/tmp}/spendsheet-tools.XXXXXX")"
  rm -f "$TOOLS_MISSING_MARKER"

  echo "Tools"
  tools_each _tools_report_row

  if [ -f "$TOOLS_MISSING_MARKER" ]; then
    rm -f "$TOOLS_MISSING_MARKER"
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Authentication — reported, never performed
# ---------------------------------------------------------------------------

tools_auth() {
  echo
  echo "Sign-in"

  # `wrangler whoami` exits **0 while telling you it is not authenticated**, so
  # the exit code is not the answer and trusting it reported a signed-out CLI
  # as ready — which would have failed half way through writing the secrets.
  # The test is therefore a *positive* signal in the output: an authenticated
  # run prints an Account ID, and a signed-out one cannot. Biased that way on
  # purpose — a false "sign in" wastes a moment, a false "ok" wastes a
  # half-configured Worker.
  if ! tool_present wrangler; then
    printf '  %-14s %s\n' "wrangler" "- (run npm run bootstrap)"
  elif "$(tool_path wrangler)" whoami 2>/dev/null | grep -qi 'account id'; then
    printf '  %-14s %-9s\n' "wrangler" "ok"
  else
    printf '  %-14s %-9s %s\n' "wrangler" "SIGN IN" "npx wrangler login    (in web/, where it is installed)"
  fi

  # The same bias for `clasp`: only its "logged in as" line counts, and the
  # address on that line is not repeated here.
  if ! tool_present clasp; then
    printf '  %-14s %s\n' "clasp" "- (run npm run bootstrap)"
  elif "$(tool_path clasp)" show-authorized-user 2>/dev/null | grep -qi 'logged in as'; then
    printf '  %-14s %-9s\n' "clasp" "ok"
  else
    printf '  %-14s %-9s %s\n' "clasp" "SIGN IN" "npx clasp login    (at the repository root, where it is installed)"
  fi

  if tool_present gh; then
    if gh auth status >/dev/null 2>&1; then
      printf '  %-14s %-9s\n' "gh" "ok"
    else
      printf '  %-14s %-9s %s\n' "gh" "SIGN IN" "gh auth login"
    fi
  fi
}

# ---------------------------------------------------------------------------
# Installing
# ---------------------------------------------------------------------------

_tools_install_row() {
  local name="$1" installer="$3"

  tool_present "$name" && return 0

  case "$installer" in
    brew:*)
      echo "==> brew install ${installer#brew:}"
      brew install "${installer#brew:}"
      ;;
    cask:*)
      echo "==> brew install --cask ${installer#cask:}"
      brew install --cask "${installer#cask:}"
      ;;
    bootstrap)
      # One run installs every row of this kind, so the rows after the first
      # find their tool present and return above.
      echo "==> npm run bootstrap (in ${TOOLS_ROOT_DIR})"
      ( cd "$TOOLS_ROOT_DIR" && npm run bootstrap )
      ;;
    playwright)
      # After the bootstrap rows, so Playwright is there to ask. On its own
      # this is one download, where a bootstrap replaces both `node_modules`.
      echo "==> playwright install ${name}"
      "$(tool_path playwright)" install "$name"
      ;;
    manual)
      echo "==> ${name} cannot be installed from here — see the note below"
      ;;
  esac
}

tools_install() {
  if ! command -v brew >/dev/null 2>&1; then
    cat <<'NOBREW'
Homebrew is missing, and this script will not install it for you: that means
piping a script off the internet into a shell, which is a habit worth not
having. Install it yourself, then run this again:

  https://brew.sh

NOBREW
    return 1
  fi

  if node_too_old; then
    cat <<OLDNODE
Node is $(node --version) and this project needs $(node_floor) or later. Nothing
here upgrades a Node that is already installed, and no install below would run
on this one. Upgrade it, then run this again:

  brew upgrade node          if Homebrew installed it
  nvm install / fnm use      if a version manager did; .nvmrc names the line

OLDNODE
    return 1
  fi

  tools_each _tools_install_row
}
