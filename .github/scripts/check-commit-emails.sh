#!/usr/bin/env bash
set -euo pipefail

event=${1:?event required}
base=${2:?base SHA required}
head=${3:?head SHA required}
[[ $event == pull_request || $event == push ]]
[[ $base =~ ^[0-9a-f]{40}$ && $head =~ ^[0-9a-f]{40}$ ]]
# Missing/deleted history must fail, never silently reduce the checked range.
git cat-file -e "$base^{commit}"
git cat-file -e "$head^{commit}"

allowed() {
  local noreply='^[A-Za-z0-9+_.-]+(\[bot\])?@users[.]noreply[.]github[.]com$'
  [[ $1 == dimitrikennedy@gmail.com || $1 == noreply@github.com ||
    $1 =~ $noreply ]]
}

options=()
if [[ $event == push ]]; then
  options+=(--first-parent)
fi
commits=$(git rev-list "${options[@]}" "$base..$head")
failed=0
for commit in $commits; do
  author=$(git show -s --format=%ae "$commit")
  committer=$(git show -s --format=%ce "$commit")
  parents=$(git show -s --format=%P "$commit")
  # Upstream merge commits can have upstream identities. Side-branch commits
  # are excluded on pushes; ordinary first-parent commits are never exempt.
  if [[ $event == push && $parents == *' '* ]] && ! allowed "$author"; then
    continue
  fi
  if ! allowed "$author" || ! allowed "$committer"; then
    # Do not reproduce a potentially private address in public CI logs.
    echo "Commit $commit has an author or committer email outside the allowlist." >&2
    failed=1
  fi
done
exit "$failed"
