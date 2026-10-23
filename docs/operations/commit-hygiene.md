# Commit hygiene

The `Commit hygiene` workflow checks PRs targeting `hd/nightly` and pushes to that
branch. It scans `base..head` with gitleaks v8.30.1, including merged side branches
and merge patches (`-m`) so conflict-resolution additions are checked.
The release archive must match the SHA-256 pinned in the workflow before it runs.
Findings are redacted; diagnostics are not enabled.

For PRs, both the author and committer emails of every commit not already reachable
from the PR base SHA must match the allowlist in
[check-commit-emails.sh](../../.github/scripts/check-commit-emails.sh). It accepts
GitHub noreply addresses and `dimitrikennedy@gmail.com`, which is already used in
the fork's maintainer history. It does not read mailmap aliases or print rejected
addresses. This checks email metadata, not authorship authenticity.

For pushes, the email check considers only first-parent commits in `before..after`.
Merge commits whose author is outside the allowlist are exempt so upstream merges
can retain upstream identities. This deliberately trusts such merge commits and
their side-branch history; it does not prove they came from a particular upstream.
Ordinary first-parent commits always have both emails checked, as do merge commits
with allowlisted authors. PRs importing upstream commits not yet in their base
must first have that history integrated into `hd/nightly` or use the push policy.

Missing range endpoints (including an all-zero endpoint for branch creation or
deletion) fail closed. The workflow checks out full history and does not substitute
the latest branch tip for an unavailable event SHA. The public fork is fetched
anonymously, without storing credentials. This avoids recursive credential cleanup
in `actions/checkout`, which fails on vendored gitlinks that lack `.gitmodules`
entries. The fetch has no depth limit and checkout uses the event's head SHA.

Run the focused email-policy fixtures with
`bash .github/scripts/check-commit-emails.test.sh`. They create an isolated Git
repository under the worktree's ignored `.generated` directory and remove it when
finished. Run `bash .github/scripts/commit-hygiene.test.sh <verified-gitleaks-path>`
to verify anonymous checkout with malformed gitlinks and detection of an inert
marker introduced only in a merge commit. Both fixture suites also run in CI.
Workflow changes also need YAML/actionlint validation and
`vp run check:changed origin/hd/nightly` when the repository toolchain is available.
