#!/usr/bin/env bash
#
# infra.sh — stand up the accounts and secrets phase 1 needs.
#
# ## Why this is a script at all
#
# The governing rule is that one-time human operations get documented rather
# than automated, and standing up infrastructure is about as one-time as it
# gets. This is the same exception `installCredentials()` already occupies: the
# service account's private key is a multi-line PEM, and a documented procedure
# that silently corrupts one is a trap, not a procedure. Every other step here
# is along for the ride because splitting them would leave the dangerous one on
# its own with no context.
#
# It lives under `web/` rather than in the repo's `scripts/`, where the standing
# rule is that every script keeps a test beside it. This one's test is that it
# is idempotent and that `/api/health` answers afterwards.
#
# ## What it does NOT do, because it cannot
#
# Two steps are clicks in a console and no flag replaces them:
#
#   1. Creating the OAuth **client ID and secret** (APIs & Services →
#      Credentials → OAuth client ID → Web application). Authorised redirect
#      URI must be exactly  https://<your-pages-host>/api/callback
#   2. **Sharing the Sheet** with the service account as an Editor. That share
#      is the entire grant — there is no scope, no consent screen, and nothing
#      in this file can perform it.
#
# ## Two steps are NOT safe to repeat, and that is a wart rather than a design
#
# Enabling the API, creating the service account and creating the Pages project
# all no-op on a second run. Two things do not:
#
#   **A new key is minted every run and the old one is never deleted.** Old keys
#   stay valid indefinitely, so re-running accumulates live credentials to the
#   spreadsheet — and Google caps a service account at ten, so the eleventh run
#   fails outright.
#
#   **SESSION_SECRET is regenerated every run**, which signs out every device.
#
# Both should be behind explicit flags (`--new-key`, `--rotate-secret`) rather
# than happening as a side effect of re-running setup. Until they are: run this
# once, and reach for the individual `gcloud` and `wrangler` commands after.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export TOOLS_WEB_DIR="$(cd "$HERE/.." && pwd)"

# Preflight, and the reason `lib/tools.sh` exists at all. Everything below
# creates something — a service account, a key, a Pages project — so finding
# out half way through that `gcloud` is missing leaves real resources behind
# and a script that cannot simply be re-run over them. Ask first.
#
# shellcheck source=lib/tools.sh
. "$HERE/lib/tools.sh"

if ! tools_check >/dev/null 2>&1; then
  echo "This machine is not ready. Run:  ./scripts/tools.sh" >&2
  exit 1
fi

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID to your Google Cloud project}"
SPREADSHEET_ID="${SPREADSHEET_ID:?set SPREADSHEET_ID to the id of the book}"
OWNER_EMAIL="${OWNER_EMAIL:?set OWNER_EMAIL to the one Google account allowed in}"
PAGES_PROJECT="${PAGES_PROJECT:-spendsheet}"
SA_NAME="${SA_NAME:-spendsheet-web}"

SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
KEY_FILE="$(mktemp -t spendsheet-sa)"

# The key never touches the repo, and it is removed whether this exits cleanly
# or not — an `exit` skips a plain `finally`-style tail, which is the same
# lesson `scripts/deploy.mjs` learned about restoring the manifest.
trap 'rm -f "$KEY_FILE"' EXIT

echo "==> Enabling the Sheets API on ${PROJECT_ID}"
gcloud services enable sheets.googleapis.com --project "$PROJECT_ID"

echo "==> Service account ${SA_EMAIL}"
if ! gcloud iam service-accounts describe "$SA_EMAIL" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SA_NAME" \
    --project "$PROJECT_ID" \
    --display-name "Spendsheet web"
fi

# No IAM role is granted, deliberately. The account reaches exactly one
# spreadsheet, and it reaches it because that file is shared with it — not
# because it holds a project-wide permission. Nothing else in the project is
# visible to it.
echo "==> Minting a key"
gcloud iam service-accounts keys create "$KEY_FILE" \
  --iam-account "$SA_EMAIL" \
  --project "$PROJECT_ID"

echo "==> Cloudflare Pages project ${PAGES_PROJECT}"
npx wrangler pages project create "$PAGES_PROJECT" --production-branch main 2>/dev/null \
  || echo "    (already exists)"

# Piped rather than passed as an argument: an argument is visible in `ps` and
# lands in shell history. `wrangler secret put` reads stdin for exactly this.
echo "==> Secrets"
put_secret() {
  printf '%s' "$2" | npx wrangler pages secret put "$1" --project-name "$PAGES_PROJECT"
}

put_secret SERVICE_ACCOUNT_KEY "$(cat "$KEY_FILE")"
put_secret OWNER_EMAIL "$OWNER_EMAIL"
put_secret SPREADSHEET_ID "$SPREADSHEET_ID"

# Generated here rather than chosen, because a session secret someone typed is
# a session secret someone can type again.
put_secret SESSION_SECRET "$(openssl rand -base64 48)"

echo
echo "Two things remain, and neither is scriptable:"
echo
echo "  1. Create an OAuth client ID (Web application) in the Google console"
echo "     with redirect URI  https://<pages-host>/api/callback  and then:"
echo "       npx wrangler pages secret put GOOGLE_CLIENT_ID     --project-name ${PAGES_PROJECT}"
echo "       npx wrangler pages secret put GOOGLE_CLIENT_SECRET --project-name ${PAGES_PROJECT}"
echo
echo "  2. Share the spreadsheet with this address as an Editor:"
echo "       ${SA_EMAIL}"
echo
echo "Then:  npm run build && npm run deploy"
echo "Check: curl https://<pages-host>/api/health"
