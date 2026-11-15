#!/usr/bin/env bash
# Push dsh-session-switches to GitHub and point the market index at the pushed commit.
#
#   scripts/publish.sh            # owner/repo come from package.json repository
#
# The owner placeholders are already resolved (Qika-GH). Needs an authenticated
# remote: HTTPS with a PAT, or SSH. GIT_CONFIG_GLOBAL=/dev/null is used because a
# global insteadOf rule on this machine rewrites github.com through a mirror.
set -euo pipefail
cd "$(dirname "$0")/.."

REMOTE=$(git config --get remote.origin.url)
echo "==> remote: $REMOTE"

echo "==> push"
GIT_CONFIG_GLOBAL=/dev/null git push -u origin main

SHA=$(git rev-parse HEAD)
echo "==> repointing market/index.json at $SHA"
node - "$SHA" <<'NODE'
import fs from 'node:fs'
const sha = process.argv[2]
const path = 'market/index.json'
const index = JSON.parse(fs.readFileSync(path, 'utf8'))
for (const plugin of index.plugins ?? []) {
  for (const version of plugin.versions ?? []) {
    if (version.source?.type === 'git') version.source.commit = sha
  }
}
fs.writeFileSync(path, JSON.stringify(index, null, 2) + '\n')
console.log('market/index.json ->', sha)
NODE

git add market/index.json
git commit -q -m "chore: point market index at $SHA"
GIT_CONFIG_GLOBAL=/dev/null git push

echo
echo "Index URL for DSH:"
echo "  https://cdn.jsdelivr.net/gh/Qika-GH/dsh-session-switches@main/market/index.json"
echo "Verify with: scripts/check-visibility.sh Qika-GH dsh-session-switches main"
