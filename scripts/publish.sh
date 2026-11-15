#!/usr/bin/env bash
# Publish dsh-session-switches to GitHub.
#
#   scripts/publish.sh <github-owner> [repo-name]
#
# Rewrites the YOUR_GITHUB_USER placeholders, creates the first commit, pushes,
# then points market/index.json at the pushed commit and pushes again.
# Requires: git, node, and an authenticated GitHub remote (HTTPS PAT or SSH agent).
set -euo pipefail
OWNER="${1:-}"
REPO="${2:-dsh-session-switches}"
if [ -z "$OWNER" ]; then
  echo "usage: scripts/publish.sh <github-owner> [repo-name]" >&2
  exit 2
fi

cd "$(dirname "$0")/.."

echo "==> rewriting placeholders to $OWNER/$REPO"
files=$(git ls-files)
for f in $files; do
  if grep -q 'YOUR_GITHUB_USER\|YOUR_GITHUB_REPO' "$f" 2>/dev/null; then
    sed -i "s/YOUR_GITHUB_USER/$OWNER/g; s/YOUR_GITHUB_REPO/$REPO/g" "$f"
  fi
done
node scripts/build-client.mjs >/dev/null

if ! git diff --quiet; then
  git add -A
  git commit -q -m "chore: point package metadata at $OWNER/$REPO"
fi

echo "==> remote"
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "https://github.com/$OWNER/$REPO.git"
else
  git remote add origin "https://github.com/$OWNER/$REPO.git"
fi

echo "==> push"
git push -u origin main

SHA=$(git rev-parse HEAD)
echo "==> index now points at $SHA"
node - "$SHA" <<'NODE'
import fs from 'node:fs'
const sha = process.argv[2]
const path = 'market/index.json'
const index = JSON.parse(fs.readFileSync(path, 'utf8'))
for (const plugin of index.plugins ?? []) {
  for (const version of plugin.versions ?? []) {
    if (version.source?.type === 'git') version.commit = sha
  }
}
fs.writeFileSync(path, JSON.stringify(index, null, 2) + '\n')
console.log('market/index.json ->', sha)
NODE

git add market/index.json
git commit -q -m "chore: point market index at $SHA"
git push

echo
echo "Done. Remaining manual steps:"
echo "  1. add the GitHub topic 'dsh-plugin' to the repo (Settings -> Topics)"
echo "  2. add this index in DSH: Plugins -> experimental -> Custom plugin indexes ->"
echo "     https://cdn.jsdelivr.net/gh/$OWNER/$REPO@main/market/index.json"
echo "  3. optional: fork awesome-dsh-plugin, copy market/community-entry.yml to data/plugins/${OWNER}__${REPO}.yml, open a PR"
echo "  4. optional: publish to npm (registry must be https://registry.npmjs.org)"
