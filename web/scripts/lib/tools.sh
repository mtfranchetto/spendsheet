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
# **It never signs anything in.** `wrangler login` opens a browser and wants a
# human. It reports whether it is authenticated, which is the part that is
# actually easy to get wrong.
#
# Written for bash 3.2, because that is what `/bin/bash` is on macOS and a
# script that only runs under Homebrew's bash is a script that fails on exactly
# the fresh machine it exists for. No associative arrays, no `mapfile`.

# name | kind | installer | why we need it
#
# installer is one of:
#   brew:<formula>   a Homebrew formula
#   cask:<name>      a Homebrew cask
#   npm              installed per-project by `npm install`, never globally
#   manual           a human has to do it
TOOLS_TABLE='
brew|required|manual|installs everything else on macOS
node|required|brew:node|vite, vitest and wrangler all run on it
npm|required|brew:node|comes with node
git|required|manual|ships with the Xcode command line tools
openssl|required|brew:openssl|generates SESSION_KEY
wrangler|required|npm|deploys the Worker and writes its secrets
gh|optional|brew:gh|opens pull requests
jq|optional|brew:jq|reads JSON in scripts and by hand
rsvg-convert|optional|brew:librsvg|regenerates apple-touch-icon.png from icon.svg
'

# `wrangler` is deliberately project-local rather than global: the version is
# pinned in `web/package-lock.json`, so every machine and CI get the same one.
# A globally installed wrangler is a version nobody agreed on, which is how a
# deploy behaves differently on one laptop.
tool_present() {
  case "$1" in
    wrangler) [ -x "${TOOLS_WEB_DIR}/node_modules/.bin/wrangler" ] ;;
    *) command -v "$1" >/dev/null 2>&1 ;;
  esac
}

tool_version() {
  case "$1" in
    wrangler) "${TOOLS_WEB_DIR}/node_modules/.bin/wrangler" --version 2>/dev/null | tail -1 ;;
    node|npm) "$1" --version 2>/dev/null ;;
    openssl) openssl version 2>/dev/null | cut -d' ' -f1-2 ;;
    git) git --version 2>/dev/null | sed 's/git version //' ;;
    gh) gh --version 2>/dev/null | head -1 | sed 's/gh version //' | cut -d' ' -f1 ;;
    brew) brew --version 2>/dev/null | head -1 | sed 's/Homebrew //' ;;
    *) "$1" --version 2>/dev/null | head -1 ;;
  esac
}

# The directory `wrangler` is project-local to. Set by the caller so this file
# works from anywhere; defaults to the `web/` this lives under.
TOOLS_WEB_DIR="${TOOLS_WEB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# Walk the table, calling back for each row. Keeps the parsing in one place
# rather than repeating the same `while IFS` in check and install.
tools_each() {
  local callback="$1" name kind installer why
  printf '%s\n' "$TOOLS_TABLE" | while IFS='|' read -r name kind installer why; do
    [ -n "$name" ] || continue
    "$callback" "$name" "$kind" "$installer" "$why"
  done
}

# ---------------------------------------------------------------------------
# Checking
# ---------------------------------------------------------------------------

_tools_report_row() {
  local name="$1" kind="$2" installer="$3" why="$4"

  if tool_present "$name"; then
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
  TOOLS_MISSING_MARKER="$(mktemp -t spendsheet-tools)"
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
    printf '  %-14s %s\n' "wrangler" "- (run npm install in web/)"
  elif "${TOOLS_WEB_DIR}/node_modules/.bin/wrangler" whoami 2>/dev/null | grep -qi 'account id'; then
    printf '  %-14s %-9s\n' "wrangler" "ok"
  else
    printf '  %-14s %-9s %s\n' "wrangler" "SIGN IN" "npx wrangler login"
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
    npm)
      echo "==> npm install (in ${TOOLS_WEB_DIR})"
      ( cd "$TOOLS_WEB_DIR" && npm install )
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

  tools_each _tools_install_row
}
