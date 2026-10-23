#!/usr/bin/env bash
set -euo pipefail

base=${1:?base SHA required}
head=${2:?head SHA required}
gitleaks=${3:?gitleaks executable required}
[[ $base =~ ^[0-9a-f]{40}$ && $head =~ ^[0-9a-f]{40}$ ]]
git cat-file -e "$base^{commit}"
git cat-file -e "$head^{commit}"
# Compare merges with each parent so conflict-resolution additions are scanned.
"$gitleaks" git --redact --log-opts="-m $base..$head"
