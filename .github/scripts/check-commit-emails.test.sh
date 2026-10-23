#!/usr/bin/env bash
set -euo pipefail

root=$(git rev-parse --show-toplevel)
script="$root/.github/scripts/check-commit-emails.sh"
mkdir -p "$root/.generated"
fixture=$(mktemp -d "$root/.generated/commit-emails.XXXXXX")
trap 'rm -rf "$fixture"' EXIT
cd "$fixture"
git init -q
tree=$(git mktree </dev/null)
good=dimitrikennedy@gmail.com
bad=contributor@example.com

commit() {
  local author=$1 committer=$2
  shift 2
  GIT_AUTHOR_NAME=Example GIT_COMMITTER_NAME=Example \
    GIT_AUTHOR_EMAIL="$author" GIT_COMMITTER_EMAIL="$committer" \
    git commit-tree "$tree" "$@" -m fixture
}

expect() {
  local expected=$1
  shift
  local actual=0
  bash "$script" "$@" >result 2>&1 || actual=$?
  if [[ $actual != "$expected" ]]; then
    echo "Expected status $expected, got $actual: $*" >&2
    cat result >&2
    exit 1
  fi
  if grep -q "$bad" result; then
    echo 'Disallowed email leaked into output' >&2
    exit 1
  fi
}

base=$(commit "$bad" "$bad")
valid=$(commit "$good" "$good" -p "$base")
expect 0 pull_request "$base" "$valid"
expect 0 push "$base" "$valid"
expect 0 pull_request "$base" "$base"
for email in '123+example@users.noreply.github.com' 'example@users.noreply.github.com' '123+example[bot]@users.noreply.github.com' noreply@github.com; do
  head=$(commit "$email" "$email" -p "$base")
  expect 0 pull_request "$base" "$head"
done
for email in "$bad" 'example@users.noreply.github.com.invalid' '@users.noreply.github.com'; do
  head=$(commit "$email" "$good" -p "$base")
  expect 1 pull_request "$base" "$head"
  expect 1 push "$base" "$head"
  head=$(commit "$good" "$email" -p "$base")
  expect 1 pull_request "$base" "$head"
done
invalid=$(commit "$good" "$bad" -p "$base")
tip=$(commit "$good" "$good" -p "$invalid")
expect 1 pull_request "$base" "$tip"
expect 1 push "$base" "$tip"
upstream=$(commit "$bad" "$bad" -p "$base")
merge=$(commit "$bad" "$bad" -p "$valid" -p "$upstream")
expect 0 push "$base" "$merge"
expect 1 pull_request "$base" "$merge"
merge=$(commit "$good" "$bad" -p "$valid" -p "$upstream")
expect 1 push "$base" "$merge"
merge=$(commit "$good" "$good" -p "$valid" -p "$upstream")
expect 0 push "$base" "$merge"
# PR base reachability excludes upstream history already merged into the base.
topic=$(commit "$good" "$good" -p "$upstream")
expect 0 pull_request "$merge" "$topic"
expect 128 push 0000000000000000000000000000000000000000 "$valid"
expect 1 pull_request invalid "$valid"
echo 'Commit email range tests passed.'
