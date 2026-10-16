# Hack Dance releases

HD builds carry the selected local fixes on top of a published upstream release.
`main` mirrors upstream. Keep contribution fixes on their own branches and HD
maintenance commits on `hd/nightly`. The SSH fix branch does not contain this
release setup.

Use **Actions → HD: Sync and release → Run workflow** in `hack-dance/t3code-1`.
Select `hd/nightly`, choose upstream `nightly` or `stable`, and optionally pin an
exact upstream release tag. Both upstream bases ship on the HD Nightly train.

- `check` reports the newest published upstream release without building or
  changing branches. Scheduled runs do this every six hours.
- `candidate` replays HD commits, runs checks, and uploads test builds as workflow
  artifacts. `pilot` builds macOS arm64 and Linux x64; `all` also builds macOS x64,
  Linux arm64, and both Windows architectures. Candidates use preview versions
  and have no update feed. Test them with an isolated profile and copied state.
- `publish` requires signing configuration for the selected targets and the repository
  variable `HD_RELEASE_ENABLED=true`. It stages all assets in a draft release,
  then publishes it. A pilot publishes macOS arm64 and Linux x64. After HD has
  shipped additional architectures, publication requires `all` so existing hosts
  keep receiving updates. Configure required reviewers on the `hd-release` GitHub
  environment if publication should require approval.

The workflow must exist on the fork's default branch for manual dispatch and
scheduled checks to be available. Use `hd/nightly` as the default branch while
keeping `main` as the upstream mirror. GitHub may require enabling Actions in a
new fork before its first run. The inherited upstream release workflow is disabled
in the HD fork.

For an agent or terminal, the same candidate operation is:

```sh
gh workflow run hd-release.yml --repo hack-dance/t3code-1 --ref hd/nightly \
  -f mode=candidate -f upstream_channel=nightly -f targets=pilot
```

Follow the run in Actions. Its summary and `hd-release-metadata` artifact record
the upstream tag and commit, maintenance commit, replayed patches, candidate
commit, and version. Candidate branches are unique to each run; they never
overwrite the maintenance branch or contribution branches.

If a patch conflicts, the preparation job identifies the patch and paths. Fix
the patch against the selected upstream base on the maintenance branch, then
retry. Do not bypass checks to publish. `.github/hd-release.json` records the
common ancestor below the HD overlay; changing it changes which commits replay.
Keep the overlay linear. Equivalent fixes already present upstream are skipped.

## Signing and first installation

macOS publication requires `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`,
`APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `MACOS_PROVISIONING_PROFILE`, and the
`APPLE_TEAM_ID` repository variable. Windows publication requires the Azure
Trusted Signing secrets named by `release-desktop.yml`. Use our signing
identities; upstream credentials are not available to the fork.

The HD macOS app uses `dance.hack.t3code` under our Apple team. Its Nightly
product name and state paths remain the same.

Before enabling publication, verify macOS entitlements and account access with
our signing identity, then test an HD-to-HD update. Keeping the upstream bundle
ID does not make its signing identity ours. The initial transition may require
a manual app replacement. Back up the previous app and a consistent copy of its
state; an older binary may not read a database migrated by a newer build.

Preserve the app profile, T3 home, provider homes, and connection endpoints during
cutover. Stop the old production runtime before starting its replacement. Never
test with a second server pointed at the production database.

## Installing across surfaces

HD desktop builds use the fork's GitHub update feed. HD headless services use
the same fork's release index, checksums, and CLI archives. After each host has
been migrated to HD, the existing update button can update connected hosts and
restart the local desktop last. An upstream host does not gain the HD update
source merely by connecting to an HD client; migrate that host first.

The fork's `scripts/install.sh` and `scripts/install.ps1` install HD archives and
default to Nightly. Inspect and run a downloaded copy, using `T3CODE_VERSION` to
pin a release. Do not use the upstream install URL or `npx t3` to install HD.
There is no HD npm package in this workflow.

Local web clients ship with their server. A hosted HD web app needs its own
deployment; `app.t3.codes` remains upstream. Upstream mobile apps can connect
while their protocol is compatible. HD mobile changes need our own Expo project,
signing, and distribution; a desktop GitHub release does not update those apps.
