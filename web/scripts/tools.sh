#!/usr/bin/env bash
#
# tools.sh — is this machine ready, and make it ready.
#
#   ./scripts/tools.sh           what is present, what is missing, what needs
#                                signing in. Changes nothing. Exits non-zero if
#                                a required tool is absent, so CI or another
#                                script can gate on it.
#
#   ./scripts/tools.sh install   install whatever is missing, then report.
#
# The table of what "ready" means lives in `lib/tools.sh`, so `infra.sh` can
# ask the same question without duplicating the answer.
#
# Neither mode ever signs you in. `gcloud auth login` and `wrangler login` open
# a browser and want a human; this reports which of them still need one, which
# is the half people actually forget.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export TOOLS_WEB_DIR="$(cd "$HERE/.." && pwd)"

# shellcheck source=lib/tools.sh
. "$HERE/lib/tools.sh"

case "${1:-check}" in
  install)
    tools_install
    echo
    ;;
  check) ;;
  *)
    echo "usage: $(basename "$0") [check|install]" >&2
    exit 2
    ;;
esac

# `|| ready=1` rather than letting `set -e` take it: the auth report below is
# the most useful thing on the screen for someone whose machine is not ready,
# and exiting before printing it would hide it exactly when it is wanted.
ready=0
tools_check || ready=1
tools_auth

echo
if [ "$ready" -ne 0 ]; then
  echo "Something required is missing. Run:  $(basename "$0") install"
  exit 1
fi

echo "Ready. Next:  see web/README.md, or scripts/infra.sh to stand up the cloud side."
