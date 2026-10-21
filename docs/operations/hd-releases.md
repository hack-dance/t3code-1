# Hack Dance releases

HD builds are `hd/nightly`: upstream merged in, with the HD fixes on top. `main`
mirrors upstream. Keep contribution fixes on their own branches and HD
maintenance commits on `hd/nightly`. The SSH fix branch does not contain this
release setup.

## Automatic upstream sync

An external scheduled job keeps `hd/nightly` current. When upstream publishes a
newer Nightly, it merges that release tag into `hd/nightly` with a merge commit
(never a rebase), resolves conflicts in favor of the HD fixes, runs typecheck,
lint and the HD test set, and requires independent code reviews. Only when they
approve does it push `hd/nightly` (fast-forward, never forced) and dispatch
`publish` with `source=head` for the merged tag. It stops and reports on
conflicts it cannot resolve, failing checks, or a missing approval. Upstream
workflow-file changes arrive through that normal push, so Actions never writes
workflows.

## Running the workflow

Use **Actions → HD: Sync and release → Run workflow** in `hack-dance/t3code-1`.
Select `hd/nightly`, choose upstream `nightly` or `stable`, and optionally pin an
exact upstream release tag. Both upstream bases ship on the HD Nightly train.

`source` decides what is built:

- `head` (default) builds the pushed commit as-is. The upstream base is the pinned
  tag, or else the newest published upstream release already in the commit's
  history; the run fails if the commit contains none of them. Pin the tag that was
  actually merged so the version base matches it. Nothing is pushed.
- `replay` is the older flow: it replays the HD commits above
  `.github/hd-release.json`'s `overlayBase` onto the selected upstream release and
  pushes an `hd/candidate/*` branch with the workflow token. It only works while
  that overlay is linear, so it stops once `hd/nightly` contains an upstream merge,
  and the push fails whenever upstream changed a workflow file.

Modes:

- `check` reports the newest published upstream release without building or
  changing branches. Scheduled runs do this every six hours.
- `candidate` runs checks and uploads test builds as workflow artifacts. `pilot`
  builds macOS arm64 and Linux x64; `all` also builds macOS x64, Linux arm64, and
  both Windows architectures. Candidates use preview versions and have no update
  feed. Test them with an isolated profile and copied state.
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
  -f mode=candidate -f source=head -f upstream_channel=nightly -f targets=pilot
```

Add `-f expected_sha=<full sha>` to make the run stop before building anything
if `hd/nightly` moved to a different commit between your push and the dispatch.
The automatic sync always passes it.

Follow the run in Actions. Its summary and `hd-release-metadata` artifact record
the source, upstream tag and commit, maintenance commit, and version (plus, for
`replay`, the replayed patches and candidate commit). Replay candidate branches are
unique to each run; they never overwrite the maintenance branch or contribution
branches.

To merge upstream by hand, merge the release tag into `hd/nightly`
(`git merge --no-ff <tag>`), keep the HD behavior when resolving conflicts, run the
checks, and push without force. Do not bypass checks to publish.

## Signing and first installation

macOS publication requires `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`,
`APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `MACOS_PROVISIONING_PROFILE`, and the
`APPLE_TEAM_ID` repository variable. Windows publication requires the Azure
Trusted Signing secrets named by `release-desktop.yml`. Use our signing
identities; upstream credentials are not available to the fork.

The HD macOS app uses `dance.hack.t3code` under our Apple team. State paths are
unchanged from upstream.

## Branding

HD builds are branded **Hack the Planet** with the HACK globe icon on every
update channel. The name lives in `packages/shared/src/hdBranding.ts`; the icon
set lives in `assets/hd` (see `assets/README.md`). The bundle ID, package names,
release asset names, `t3code://` URL schemes, state directories, and the Electron
runtime name stay as they were. The product name does rename the macOS
executable and app folder, the Windows exe, and the Linux deb `/opt` directory;
see the install-path notes below.
The runtime name keys macOS Keychain and Linux secret-store entries, so renaming
it would orphan stored credentials. Keychain prompts therefore still name
"T3 Code Nightly".

The packaged product name does change, which moves a few install paths on the
first HD build that carries the rebrand:

- macOS: the executable inside the bundle becomes `Contents/MacOS/Hack the
Planet`. An in-place update keeps the existing bundle folder name (for example
  `T3 Code (Nightly).app`); a fresh DMG install is `Hack the Planet.app` and
  leaves any older bundle in place, so remove the old one by hand.
- Linux deb: the install directory moves from `/opt/T3 Code (Nightly)` to
  `/opt/Hack the Planet`. The package name, `t3code` executable, and
  `t3code.desktop` entry are unchanged. AppImage updates replace the file in
  place.
- Windows: updates reuse the registered install folder, but the executable
  becomes `Hack the Planet.exe`, so taskbar pins to the old executable go stale.
- The `t3` CLI shim and Linux URL handler record the desktop executable's
  absolute path. The app rewrites both on its next launch, so the old path only
  lingers between an update and the relaunch that follows it. Scripts outside
  this repository that hard-code the old app or executable name need updating.

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
