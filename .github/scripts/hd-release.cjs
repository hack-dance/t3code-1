const ChildProcess = require("node:child_process");
const Fs = require("node:fs");
const Path = require("node:path");

const config = require("../hd-release.json");

function selectRelease(releases, channel, tag) {
  if (!["nightly", "stable"].includes(channel)) throw new Error("Unknown upstream channel.");
  const pattern =
    channel === "nightly" ? /^v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/ : /^v\d+\.\d+\.\d+$/;
  const release = releases
    .filter((item) => !item.draft && item.published_at && pattern.test(item.tag_name))
    .filter((item) => !tag || item.tag_name === tag)
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
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
  if (process.env.GITHUB_REPOSITORY !== config.repository)
    throw new Error("HD workflow is fork-only.");
  const releases = JSON.parse(
    exec("gh", ["api", "--paginate", "--slurp", `repos/${config.upstream}/releases?per_page=100`]),
  ).flat();
  const release = selectRelease(releases, channel, process.env.HD_UPSTREAM_TAG);
  const commit = JSON.parse(
    exec("gh", ["api", `repos/${config.upstream}/commits/${release.tag_name}`]),
  );
  const sourceSha = exec("git", ["rev-parse", "HEAD"]);
  const version = releaseVersion(release.tag_name, process.env.GITHUB_RUN_ID, mode);
  const metadata = {
    upstreamTag: release.tag_name,
    upstreamSha: commit.sha,
    sourceSha,
    version,
    mode,
    repository: config.repository,
  };
  // Keep the pinned inputs even when replay fails, so an agent can reproduce
  // the conflict without relying on whichever upstream release is newest later.
  Fs.writeFileSync("hd-release.json", JSON.stringify(metadata, null, 2) + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) {
    Fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## HD ${mode}\n\nUpstream: ${release.tag_name} (${commit.sha})\n\nMaintenance: ${sourceSha}\n\nVersion: ${version}\n`,
    );
  }
  if (mode !== "check") {
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

module.exports = { selectRelease, releaseVersion, prepareCandidate };
if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
