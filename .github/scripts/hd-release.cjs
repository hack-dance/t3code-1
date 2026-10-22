const ChildProcess = require("node:child_process");
const Fs = require("node:fs");
const Path = require("node:path");

const config = require("../hd-release.json");

/** Published upstream releases of a channel, newest first. */
function channelReleases(releases, channel) {
  if (!["nightly", "stable"].includes(channel)) throw new Error("Unknown upstream channel.");
  const pattern =
    channel === "nightly" ? /^v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/ : /^v\d+\.\d+\.\d+$/;
  return releases
    .filter((item) => !item.draft && item.published_at && pattern.test(item.tag_name))
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
}

function selectRelease(releases, channel, tag) {
  const release = channelReleases(releases, channel).find((item) => !tag || item.tag_name === tag);
  if (!release)
    throw new Error(`No published upstream ${channel} release${tag ? ` matching ${tag}` : ""}.`);
  return release;
}

function releaseVersion(upstreamTag, runId, mode, now = new Date()) {
  const base = /^v(\d+\.\d+\.\d+)(?:-nightly\.\d{8}\.\d+)?$/.exec(upstreamTag)?.[1];
  if (!base || !/^[1-9]\d*$/.test(String(runId)))
    throw new Error("Invalid release version inputs.");
  if (!["check", "candidate", "publish"].includes(mode)) throw new Error("Unknown release mode.");
  // Keep the channel parser and Nightly app identity. A stable upstream base
  // still ships on our Nightly train; candidate builds have no update feed.
  const channel = mode === "publish" ? "nightly" : "preview";
  const date = now.toISOString().slice(0, 10).replaceAll("-", "");
  return `${base}-${channel}.${date}.${runId}`;
}

/** A pilot must not strand an architecture already using the HD update feed. */
function assertPublishCoverage(releases, targets) {
  if (!["pilot", "all"].includes(targets)) throw new Error("Unknown HD target set.");
  if (targets === "all") return;
  const additionalPlatform = /(?:-darwin-x64|-linux-arm64|-win32-|-x64\.dmg$|\.exe$)/i;
  if (
    releases.some(
      (release) =>
        !release.draft &&
        /^v\d+\.\d+\.\d+-nightly\./.test(release.tag_name) &&
        release.assets?.some((asset) => additionalPlatform.test(asset.name)),
    )
  ) {
    throw new Error(
      "HD has shipped additional architectures; publish all targets to preserve their updates.",
    );
  }
}

/** A published, non-draft HD Nightly already built from this maintenance commit. */
function publishedRelease(releases, sourceSha) {
  return releases.find(
    (release) =>
      !release.draft &&
      /^v\d+\.\d+\.\d+-nightly\./.test(release.tag_name) &&
      (release.target_commitish === sourceSha ||
        (release.body || "")
          .split(/\r?\n/)
          .some((line) => line.trim() === `Maintenance: ${sourceSha}`)),
  );
}

/**
 * Head source candidates, newest first: the pinned release only, or every published release
 * of the channel. Scheduled publication requires the latest release, so an unresolved sync
 * cannot silently publish an older base. `resolve` maps a tag to its commit, or null if missing.
 */
function headCandidates(releases, channel, pinned, resolve, requireLatest = false) {
  const ordered =
    pinned || requireLatest
      ? [selectRelease(releases, channel, pinned)]
      : channelReleases(releases, channel);
  return ordered.map((item) => ({
    tag: item.tag_name,
    sha: resolve(item.tag_name),
    release: item,
  }));
}

/**
 * Head source: the maintenance branch already merged upstream, so build it as pushed.
 * Returns the newest candidate release whose commit is in the maintenance history.
 * `candidates` are newest first; each carries the tag and its resolved commit.
 */
function selectMergedRelease({ sourceDir, sourceSha, candidates }) {
  for (const candidate of candidates) {
    if (!candidate.sha || !/^[a-f0-9]{40}$/.test(candidate.sha)) continue;
    try {
      exec("git", ["merge-base", "--is-ancestor", candidate.sha, sourceSha], sourceDir);
      return candidate;
    } catch {
      // Not merged yet; try the next older release.
    }
  }
  const shown = candidates.slice(0, 5).map((candidate) => candidate.tag);
  const names =
    (shown.join(", ") || "none") +
    (candidates.length > shown.length ? ` and ${candidates.length - shown.length} older` : "");
  if (candidates.length > 0 && candidates.every((candidate) => !candidate.sha)) {
    throw new Error(`Upstream has no tag for ${names}.`);
  }
  throw new Error(
    `The maintenance commit ${sourceSha} contains none of the upstream releases (${names}). Merge upstream into hd/nightly first.`,
  );
}

function exec(command, args, cwd) {
  return ChildProcess.execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

/** Replays only the selected HD commits; the maintenance checkout is never reset. */
function prepareCandidate({ sourceDir, candidateDir, upstreamSha, overlayBase, sourceSha }) {
  const git = (args, cwd = sourceDir) => exec("git", args, cwd);
  if (!/^[a-f0-9]{40}$/.test(upstreamSha)) throw new Error("Upstream must be a resolved commit.");
  git(["merge-base", "--is-ancestor", overlayBase, sourceSha]);
  const commits = git(["rev-list", "--reverse", "--topo-order", `${overlayBase}..${sourceSha}`])
    .split("\n")
    .filter(Boolean);
  if (git(["rev-list", "--merges", `${overlayBase}..${sourceSha}`])) {
    throw new Error(
      "HD overlays must be linear commits. Resolve merges on the maintenance branch first.",
    );
  }
  git(["worktree", "add", "--detach", candidateDir, upstreamSha]);
  // git cherry detects equivalent patches already applied upstream, including
  // fixes which landed under different commit IDs.
  const equivalent = new Set(
    git(["cherry", upstreamSha, sourceSha, overlayBase])
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2)),
  );
  const skippedCommits = [];
  for (const commit of commits) {
    if (equivalent.has(commit) || git(["merge-base", commit, upstreamSha]) === commit) {
      skippedCommits.push(commit);
      continue;
    }
    try {
      git(
        [
          "-c",
          "user.name=HD Release",
          "-c",
          "user.email=hd-release@users.noreply.github.com",
          "-c",
          "commit.gpgsign=false",
          "cherry-pick",
          "--empty=drop",
          commit,
        ],
        candidateDir,
      );
    } catch {
      const files = git(["diff", "--name-only", "--diff-filter=U"], candidateDir);
      throw new Error(
        `HD patch ${commit} failed to apply. Review the candidate checkout before retrying.\n${files}`,
      );
    }
  }
  return {
    candidateSha: git(["rev-parse", "HEAD"], candidateDir),
    overlayCommits: commits,
    skippedCommits,
  };
}

function main() {
  const mode = process.env.HD_MODE || "check";
  const channel = process.env.HD_UPSTREAM_CHANNEL || "nightly";
  const targets = process.env.HD_TARGETS || "pilot";
  if (process.env.GITHUB_REPOSITORY !== config.repository)
    throw new Error("HD workflow is fork-only.");
  const source = process.env.HD_SOURCE || "head";
  if (!["head", "replay"].includes(source)) throw new Error("Unknown HD source.");
  if (process.env.HD_UPSTREAM_TAG && !/^v[\w.-]+$/.test(process.env.HD_UPSTREAM_TAG))
    throw new Error("Invalid upstream tag.");
  const sourceSha = exec("git", ["rev-parse", "HEAD"]);
  // Record the inputs first, so every failed preparation still uploads metadata that lets an
  // agent reproduce it without relying on whichever upstream release is newest later.
  const inputs = {
    sourceSha,
    mode,
    source,
    targets,
    channel,
    upstreamTag: process.env.HD_UPSTREAM_TAG || null,
    repository: config.repository,
  };
  Fs.writeFileSync("hd-release.json", JSON.stringify(inputs, null, 2) + "\n");
  const releases = JSON.parse(
    exec("gh", ["api", "--paginate", "--slurp", `repos/${config.upstream}/releases?per_page=100`]),
  ).flat();
  let release = selectRelease(releases, channel, process.env.HD_UPSTREAM_TAG);
  let commit;
  if (source === "head" && mode !== "check") {
    // Build exactly what was pushed. The upstream base is the newest published release
    // (or the pinned one) that the maintenance history already contains.
    exec("git", [
      "fetch",
      "--no-tags",
      `https://github.com/${config.upstream}.git`,
      "+refs/tags/*:refs/hd-upstream/tags/*",
    ]);
    const candidates = headCandidates(
      releases,
      channel,
      process.env.HD_UPSTREAM_TAG,
      (tag) => {
        try {
          return exec("git", [
            "rev-parse",
            "--verify",
            "--quiet",
            `refs/hd-upstream/tags/${tag}^{commit}`,
          ]);
        } catch {
          return null; // A release whose tag is missing upstream cannot be the merged base.
        }
      },
      process.env.HD_REQUIRE_LATEST_MERGED === "true",
    );
    const merged = selectMergedRelease({ sourceDir: process.cwd(), sourceSha, candidates });
    release = merged.release;
    commit = { sha: merged.sha };
  } else {
    commit = JSON.parse(
      exec("gh", ["api", `repos/${config.upstream}/commits/${release.tag_name}`]),
    );
  }
  if (mode === "publish") {
    const prior = JSON.parse(
      exec("gh", [
        "api",
        "--paginate",
        "--slurp",
        `repos/${config.repository}/releases?per_page=100`,
      ]),
    ).flat();
    assertPublishCoverage(prior, targets);
    // Scheduled runs publish only new maintenance commits; a repeat is a clean no-op.
    const existing =
      process.env.HD_SKIP_IF_PUBLISHED === "true" ? publishedRelease(prior, sourceSha) : null;
    if (existing) {
      const message = `${sourceSha} is already published as ${existing.tag_name}; nothing to publish.`;
      console.log(message);
      if (process.env.GITHUB_STEP_SUMMARY)
        Fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## HD publish skipped\n\n${message}\n`);
      if (process.env.GITHUB_OUTPUT) Fs.appendFileSync(process.env.GITHUB_OUTPUT, "skip=true\n");
      return;
    }
  }
  const version = releaseVersion(release.tag_name, process.env.GITHUB_RUN_ID, mode);
  const metadata = {
    upstreamTag: release.tag_name,
    upstreamSha: commit.sha,
    sourceSha,
    version,
    mode,
    source,
    targets,
    repository: config.repository,
  };
  // The resolved release replaces the inputs record before the replay can fail.
  Fs.writeFileSync("hd-release.json", JSON.stringify(metadata, null, 2) + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) {
    Fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## HD ${mode} (${source})\n\nUpstream: ${release.tag_name} (${commit.sha})\n\nMaintenance: ${sourceSha}\n\nVersion: ${version}\n`,
    );
  }
  if (mode !== "check" && source === "replay") {
    exec("git", ["fetch", "--no-tags", `https://github.com/${config.upstream}.git`, commit.sha]);
    const candidateDir = Path.join(process.env.RUNNER_TEMP, "hd-candidate");
    try {
      Object.assign(
        metadata,
        prepareCandidate({
          sourceDir: process.cwd(),
          candidateDir,
          upstreamSha: commit.sha,
          overlayBase: config.overlayBase,
          sourceSha,
        }),
      );
    } catch (error) {
      if (Fs.existsSync(candidateDir)) {
        Fs.writeFileSync(
          "hd-conflict.patch",
          exec("git", ["diff", "--binary"], candidateDir) + "\n",
        );
      }
      throw error;
    }
    const candidateRef = `hd/candidate/${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
    // Creating a new ref with an empty lease cannot overwrite another run.
    exec("git", [
      "push",
      `--force-with-lease=refs/heads/${candidateRef}:`,
      "origin",
      `${metadata.candidateSha}:refs/heads/${candidateRef}`,
    ]);
    metadata.candidateRef = candidateRef;
  }
  Fs.writeFileSync("hd-release.json", JSON.stringify(metadata, null, 2) + "\n");
  if (process.env.GITHUB_OUTPUT) {
    const outputs = {
      version,
      channel: mode === "publish" ? "nightly" : "preview",
      ref: metadata.candidateSha || sourceSha,
    };
    Fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(outputs)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    );
  }
}

module.exports = {
  selectRelease,
  selectMergedRelease,
  headCandidates,
  releaseVersion,
  prepareCandidate,
  assertPublishCoverage,
  publishedRelease,
};
if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
