#!/usr/bin/env bash
set -euo pipefail

root=$(git rev-parse --show-toplevel)
gitleaks=${1:?absolute path to verified gitleaks executable required}
mkdir -p "$root/.generated"
fixture=$(mktemp -d "$root/.generated/commit-hygiene.XXXXXX")
trap 'rm -rf "$fixture"' EXIT
export GIT_AUTHOR_NAME=Example GIT_COMMITTER_NAME=Example
export GIT_AUTHOR_EMAIL=example@users.noreply.github.com
export GIT_COMMITTER_EMAIL=$GIT_AUTHOR_EMAIL
git init -q "$fixture/source"
cd "$fixture/source"
tree=$(git mktree </dev/null)
base=$(git commit-tree "$tree" -m base)
left=$(git commit-tree "$tree" -p "$base" -m left)
right=$(git commit-tree "$tree" -p "$base" -m right)

# An inert custom rule proves merge-patch coverage without storing a credential.
cat >.gitleaks.toml <<'EOF'
[[rules]]
id = "merge-fixture"
description = "Inert regression marker"
regex = '''fixture-only-merge-marker'''
EOF
blob=$(printf 'fixture-only-merge-marker\n' | git hash-object -w --stdin)
merge_tree=$(printf '100644 blob %s\tresolution.txt\n' "$blob" | git mktree)
merge=$(git commit-tree "$merge_tree" -p "$left" -p "$right" -m merge)
git update-ref refs/heads/fixture "$merge"
# The old invocation misses the addition that exists only in the merge tree.
"$gitleaks" git --redact --log-opts="$base..$merge" >"$fixture/old-scan.log" 2>&1
status=0
bash "$root/.github/scripts/scan-commit-secrets.sh" "$base" "$merge" "$gitleaks" >"$fixture/merge-scan.log" 2>&1 || status=$?
[[ $status == 1 ]]
grep -q 'leaks found:' "$fixture/merge-scan.log"
bash "$root/.github/scripts/scan-commit-secrets.sh" "$base" "$left" "$gitleaks" >"$fixture/clean-scan.log" 2>&1

# Reproduce a nested gitlink without .gitmodules, as found in vendored history.
git update-index --add --cacheinfo "160000,$base,.repos/example/submodules/dependency"
git update-index --add --cacheinfo "100644,$blob,.github/fixture.txt"
checkout_tree=$(git write-tree)
checkout_commit=$(git commit-tree "$checkout_tree" -p "$base" -m checkout)
git update-ref refs/heads/checkout "$checkout_commit"
git checkout -q -f checkout
status=0
git submodule foreach --recursive ':' >"$fixture/full-checkout.log" 2>&1 || status=$?
[[ $status != 0 ]]
grep -q 'No url found for submodule path' "$fixture/full-checkout.log"

git init -q "$fixture/fetched"
cd "$fixture/fetched"
git remote add origin "$fixture/source"
git -c credential.helper= fetch -q --no-tags --no-recurse-submodules origin "$base" "$checkout_commit"
git checkout -q --detach "$checkout_commit"
[[ -f .github/fixture.txt ]]
[[ $(git rev-parse --is-shallow-repository) == false ]]
git cat-file -e "$base^{commit}"
if git config --local --get-regexp 'credential|extraheader|sshCommand'; then
  echo 'Checkout unexpectedly stored authentication configuration' >&2
  exit 1
fi
bash "$root/.github/scripts/check-commit-emails.sh" pull_request "$base" "$checkout_commit"
bash "$root/.github/scripts/scan-commit-secrets.sh" "$base" "$checkout_commit" "$gitleaks" >"$fixture/checkout-scan.log" 2>&1
echo 'Merge secret scan and anonymous checkout regressions passed.'
