#!/usr/bin/env bash
# Is the repo public? And can a market index be fetched from it anonymously?
#
#   scripts/check-visibility.sh <github-owner> [repo-name] [branch]
#
# Public  => anonymous HTTP 200, anonymous git ls-remote works, jsDelivr serves files.
# Private => 404 anonymously (or 403 with credentials), ls-remote asks for a username.
set -uo pipefail
OWNER="${1:-}"
REPO="${2:-dsh-session-switches}"
BRANCH="${3:-main}"
if [ -z "$OWNER" ]; then
  echo "usage: scripts/check-visibility.sh <github-owner> [repo-name] [branch]" >&2
  exit 2
fi
URL="https://github.com/$OWNER/$REPO"

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$URL")
echo "github.com/$OWNER/$REPO        -> HTTP $code  $([ "$code" = 200 ] && echo '(public)' || echo '(private or missing)')"

if GIT_TERMINAL_PROMPT=0 timeout 20 git ls-remote "https://github.com/$OWNER/$REPO.git" HEAD >/dev/null 2>&1; then
  echo "anonymous git ls-remote       -> ok (public)"
else
  echo "anonymous git ls-remote       -> refused (private, or no repo)"
fi

# jsDelivr only mirrors public repositories; this is the URL a market index needs.
for path in market/index.json package.json; do
  c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://cdn.jsdelivr.net/gh/$OWNER/$REPO@$BRANCH/$path")
  echo "jsDelivr @$BRANCH/$path -> HTTP $c"
done

echo
echo "index URL for DSH:"
echo "  https://cdn.jsdelivr.net/gh/$OWNER/$REPO@$BRANCH/market/index.json"
