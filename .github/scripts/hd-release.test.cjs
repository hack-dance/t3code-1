const Assert = require("node:assert/strict");
const ChildProcess = require("node:child_process");
const Fs = require("node:fs");
const Os = require("node:os");
const Path = require("node:path");
const { test } = require("node:test");
const {
  selectRelease,
  selectMergedRelease,
  headCandidates,
  releaseVersion,
  prepareCandidate,
  assertPublishCoverage,
  publishedRelease,
} = require("./hd-release.cjs");

test("selects published upstream releases by channel and publication time", () => {
  const release = (tag_name, published_at, draft = false) => ({ tag_name, published_at, draft });
  const releases = [
    release("v1.2.3", "2026-10-13T12:00:00Z"),
    release("v1.2.4-nightly.20261014.2", "2026-10-14T12:00:00Z"),
    release("v1.2.4-preview.20261015.3", "2026-10-15T12:00:00Z"),
    release("v1.2.4-nightly.20261015.4", "2026-10-15T13:00:00Z", true),
    release("v1.2.5", null),
  ];
  Assert.equal(selectRelease(releases, "nightly").tag_name, "v1.2.4-nightly.20261014.2");
  Assert.equal(selectRelease(releases, "stable").tag_name, "v1.2.3");
  Assert.throws(() => selectRelease(releases, "nightly", "v1.2.3"), /No published/);
  Assert.throws(() => selectRelease(releases, "preview"), /Unknown/);
});

test("an exact older release can be pinned without selecting a newer release", () => {
  const releases = [
    { tag_name: "v1.2.3", published_at: "2026-10-13T12:00:00Z" },
    { tag_name: "v1.2.4", published_at: "2026-10-14T12:00:00Z" },
  ];
  Assert.equal(selectRelease(releases, "stable", "v1.2.3").tag_name, "v1.2.3");
});

test("candidates cannot enter update feeds and published builds retain the Nightly identity", () => {
  const date = new Date("2026-10-15T00:00:00Z");
  Assert.equal(
    releaseVersion("v1.2.3", "12345678", "candidate", date),
    "1.2.3-preview.20261015.12345678",
  );
  Assert.equal(
    releaseVersion("v1.2.4-nightly.20261014.42", "12345678", "publish", date),
    "1.2.4-nightly.20261015.12345678",
  );
  Assert.throws(() => releaseVersion("v1.2.3; echo bad", "5", "publish", date), /Invalid/);
  Assert.throws(() => releaseVersion("v1.2.3", "1\nref=bad", "publish", date), /Invalid/);
  Assert.throws(() => releaseVersion("v1.2.3", "5", "unknown", date), /Unknown/);
});

function fixture(t) {
  const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "hd-release-"));
  t.after(() => Fs.rmSync(root, { recursive: true, force: true }));
  const sourceDir = Path.join(root, "source");
  const candidateDir = Path.join(root, "candidate");
  Fs.mkdirSync(sourceDir);
  const git = (...args) =>
    ChildProcess.execFileSync("git", args, {
      cwd: sourceDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: Os.devNull,
        GIT_AUTHOR_NAME: "Example",
        GIT_AUTHOR_EMAIL: "example@example.com",
        GIT_COMMITTER_NAME: "Example",
        GIT_COMMITTER_EMAIL: "example@example.com",
      },
    }).trim();
  git("init", "-b", "hd");
  const commit = (file, text, message) => {
    Fs.writeFileSync(Path.join(sourceDir, file), text);
    git("add", file);
    git("-c", "commit.gpgsign=false", "commit", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const overlayBase = commit("base.txt", "base\n", "base");
  const patch = commit("fix.txt", "fix\n", "HD fix");
  const sourceSha = git("rev-parse", "HEAD");
  git("checkout", "-b", "upstream", overlayBase);
  return { sourceDir, candidateDir, overlayBase, patch, sourceSha, git, commit };
}

test("replays HD commits onto upstream without changing the maintenance checkout", (t) => {
  const f = fixture(t);
  const upstreamSha = f.commit("upstream.txt", "upstream\n", "upstream change");
  f.git("checkout", "hd");
  const result = prepareCandidate({ ...f, upstreamSha });
  Assert.equal(f.git("rev-parse", "HEAD"), f.sourceSha);
  Assert.equal(Fs.readFileSync(Path.join(f.candidateDir, "fix.txt"), "utf8"), "fix\n");
  Assert.equal(Fs.readFileSync(Path.join(f.candidateDir, "upstream.txt"), "utf8"), "upstream\n");
  Assert.deepEqual(result.overlayCommits, [f.patch]);
  Assert.deepEqual(result.skippedCommits, []);
});

test("drops a fix already applied upstream under a different commit ID", (t) => {
  const f = fixture(t);
  const upstreamSha = f.commit("fix.txt", "fix\n", "upstream equivalent fix");
  f.git("checkout", "hd");
  const result = prepareCandidate({ ...f, upstreamSha });
  Assert.equal(result.candidateSha, upstreamSha);
  Assert.deepEqual(result.skippedCommits, [f.patch]);
});

test("stops on a conflict with the patch and paths available for agent review", (t) => {
  const f = fixture(t);
  const upstreamSha = f.commit("fix.txt", "different implementation\n", "upstream change");
  f.git("checkout", "hd");
  Assert.throws(
    () => prepareCandidate({ ...f, upstreamSha }),
    new RegExp(`${f.patch}.*\\nfix.txt`),
  );
  Assert.equal(f.git("rev-parse", "HEAD"), f.sourceSha);
  Assert.equal(Fs.readFileSync(Path.join(f.sourceDir, "fix.txt"), "utf8"), "fix\n");
});

test("head builds use the newest upstream release already merged into maintenance", (t) => {
  const f = fixture(t);
  const older = f.commit("upstream.txt", "one\n", "upstream one");
  const newer = f.commit("upstream.txt", "two\n", "upstream two");
  f.git("checkout", "hd");
  f.git("-c", "commit.gpgsign=false", "merge", "--no-ff", "--no-edit", older);
  const sourceSha = f.git("rev-parse", "HEAD");
  const candidates = [
    { tag: "v1.2.4-nightly.20261016.2", sha: newer },
    { tag: "v1.2.4-nightly.20261015.1", sha: older },
  ];
  Assert.equal(
    selectMergedRelease({ sourceDir: f.sourceDir, sourceSha, candidates }).tag,
    "v1.2.4-nightly.20261015.1",
  );
  Assert.throws(
    () => selectMergedRelease({ sourceDir: f.sourceDir, sourceSha, candidates: [candidates[0]] }),
    /contains none of the upstream releases \(v1\.2\.4-nightly\.20261016\.2\)/,
  );
  Assert.throws(
    () =>
      selectMergedRelease({
        sourceDir: f.sourceDir,
        sourceSha,
        candidates: [{ tag: "v1", sha: "not-a-sha; rm -rf /" }],
      }),
    /contains none/,
  );
  Assert.equal(f.git("rev-parse", "HEAD"), sourceSha);
});

test("head candidates cover every release, or only the pinned one", () => {
  const releases = Array.from({ length: 60 }, (_, index) => ({
    tag_name: `v1.2.4-nightly.20261001.${index}`,
    published_at: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
  }));
  const resolve = (tag) => (tag.endsWith(".0") ? "a".repeat(40) : null);
  const all = headCandidates(releases, "nightly", undefined, resolve);
  Assert.equal(all.length, 60);
  Assert.equal(all[0].tag, "v1.2.4-nightly.20261001.59");
  Assert.equal(all.at(-1).sha, "a".repeat(40));
  const pinned = headCandidates(releases, "nightly", "v1.2.4-nightly.20261001.3", resolve);
  Assert.deepEqual(
    pinned.map((item) => [item.tag, item.sha]),
    [["v1.2.4-nightly.20261001.3", null]],
  );
  Assert.throws(() => headCandidates(releases, "nightly", "v9.9.9", resolve), /No published/);
});

test("head selection skips missing tags and accepts the release commit itself", (t) => {
  const f = fixture(t);
  const release = f.commit("upstream.txt", "one\n", "upstream one");
  Assert.equal(
    selectMergedRelease({
      sourceDir: f.sourceDir,
      sourceSha: release,
      candidates: [
        { tag: "missing", sha: null },
        { tag: "v1.2.4-nightly.20261015.1", sha: release },
      ],
    }).tag,
    "v1.2.4-nightly.20261015.1",
  );
});

test("a failed preparation still records its inputs", (t) => {
  const f = fixture(t);
  f.git("checkout", "hd");
  const bin = Path.join(Path.dirname(f.sourceDir), "bin");
  Fs.mkdirSync(bin);
  Fs.writeFileSync(Path.join(bin, "gh"), "#!/bin/sh\necho '[]'\n", { mode: 0o755 });
  const run = ChildProcess.spawnSync(process.execPath, [Path.join(__dirname, "hd-release.cjs")], {
    cwd: f.sourceDir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${Path.delimiter}${process.env.PATH}`,
      GITHUB_REPOSITORY: "hack-dance/t3code-1",
      GITHUB_RUN_ID: "7",
      HD_MODE: "publish",
      HD_UPSTREAM_TAG: "v9.9.9-nightly.20261017.1",
    },
  });
  Assert.equal(run.status, 1);
  Assert.match(run.stderr, /No published upstream nightly release matching v9\.9\.9/);
  const inputs = JSON.parse(Fs.readFileSync(Path.join(f.sourceDir, "hd-release.json"), "utf8"));
  Assert.equal(inputs.sourceSha, f.sourceSha);
  Assert.equal(inputs.source, "head");
  Assert.equal(inputs.upstreamTag, "v9.9.9-nightly.20261017.1");
});

test("head selection names missing upstream tags", () => {
  Assert.throws(
    () =>
      selectMergedRelease({
        sourceDir: process.cwd(),
        sourceSha: "b".repeat(40),
        candidates: [{ tag: "v1.2.4-nightly.20261015.1", sha: null }],
      }),
    /Upstream has no tag for v1\.2\.4-nightly\.20261015\.1/,
  );
});

test("pilot publication preserves all previously shipped HD architectures", () => {
  const prior = (...names) => [
    {
      tag_name: "v1.2.3-nightly.20261015.1",
      draft: false,
      assets: names.map((name) => ({ name })),
    },
  ];
  Assert.doesNotThrow(() => assertPublishCoverage([], "pilot"));
  Assert.doesNotThrow(() =>
    assertPublishCoverage(prior("t3-1.2.3-linux-x64.tar.gz", "T3-Code-1.2.3-arm64.dmg"), "pilot"),
  );
  for (const asset of [
    "T3-Code-1.2.3-x64.dmg",
    "t3-1.2.3-linux-arm64.tar.gz",
    "t3-1.2.3-win32-x64.zip",
    "T3-Code-Setup-1.2.3.exe",
  ]) {
    Assert.throws(() => assertPublishCoverage(prior(asset), "pilot"), /preserve their updates/);
    Assert.doesNotThrow(() => assertPublishCoverage(prior(asset), "all"));
  }
  Assert.doesNotThrow(() =>
    assertPublishCoverage([{ ...prior("other.exe")[0], draft: true }], "pilot"),
  );
  Assert.throws(() => assertPublishCoverage([], "unknown"), /Unknown/);
});

test("scheduled head publication requires the latest upstream release to be merged", (t) => {
  const f = fixture(t);
  const older = f.commit("upstream.txt", "one\n", "upstream one");
  const newer = f.commit("upstream.txt", "two\n", "upstream two");
  f.git("checkout", "hd");
  f.git("-c", "commit.gpgsign=false", "merge", "--no-ff", "--no-edit", older);
  const releases = [
    { tag_name: "v1.2.4-nightly.20261016.2", published_at: "2026-10-16T12:00:00Z" },
    { tag_name: "v1.2.4-nightly.20261015.1", published_at: "2026-10-15T12:00:00Z" },
  ];
  const candidates = headCandidates(
    releases,
    "nightly",
    undefined,
    (tag) => (tag === releases[0].tag_name ? newer : older),
    true,
  );
  Assert.throws(
    () =>
      selectMergedRelease({
        sourceDir: f.sourceDir,
        sourceSha: f.git("rev-parse", "HEAD"),
        candidates,
      }),
    /Merge upstream/,
  );
  f.git("-c", "commit.gpgsign=false", "merge", "--no-ff", "--no-edit", newer);
  Assert.equal(
    selectMergedRelease({
      sourceDir: f.sourceDir,
      sourceSha: f.git("rev-parse", "HEAD"),
      candidates,
    }).sha,
    newer,
  );
});

test("workflow schedules publish while manual dispatch preserves every mode", () => {
  const workflow = Fs.readFileSync(Path.join(__dirname, "../workflows/hd-release.yml"), "utf8");
  const selection =
    /      - name: Select mode\n[\s\S]*?        run: \|\n([\s\S]*?)(?=      - name:)/.exec(
      workflow,
    )[1];
  for (const [event, requested, expected] of [
    ["schedule", "", "publish"],
    ["workflow_dispatch", "check", "check"],
    ["workflow_dispatch", "candidate", "candidate"],
    ["workflow_dispatch", "publish", "publish"],
  ]) {
    const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "hd-mode-"));
    try {
      const output = Path.join(root, "output");
      ChildProcess.execFileSync("bash", ["-e", "-c", selection], {
        env: {
          ...process.env,
          EVENT_NAME: event,
          REQUESTED_MODE: requested,
          REQUESTED_SOURCE: "head",
          GITHUB_OUTPUT: output,
        },
      });
      Assert.equal(Fs.readFileSync(output, "utf8"), `mode=${expected}\nsource=head\n`);
    } finally {
      Fs.rmSync(root, { recursive: true, force: true });
    }
  }
  Assert.match(workflow, /HD_REQUIRE_LATEST_MERGED: \$\{\{ github.event_name == 'schedule' \}\}/);
  Assert.match(workflow, /bundle:\n    needs: prepare/);
});

test("scheduled publication skips a maintenance commit that is already released", () => {
  const sha = "a".repeat(40);
  const releases = [
    { tag_name: "v0.1.2-nightly.20261022.9", draft: true, body: `Maintenance: ${sha}` },
    { tag_name: "v0.1.2-preview.20261022.8", body: `Maintenance: ${sha}` },
    { tag_name: "v0.1.2-nightly.20261022.7", body: `Maintenance: ${"b".repeat(40)}` },
  ];
  Assert.equal(publishedRelease(releases, sha), undefined);
  releases.push({
    tag_name: "v0.1.2-nightly.20261022.6",
    body: `Upstream: x\n\nMaintenance: ${sha}\n`,
  });
  Assert.equal(publishedRelease(releases, sha).tag_name, "v0.1.2-nightly.20261022.6");
  Assert.equal(
    publishedRelease([{ tag_name: "v0.1.2-nightly.20261022.5", target_commitish: sha }], sha)
      .tag_name,
    "v0.1.2-nightly.20261022.5",
  );
  const workflow = Fs.readFileSync(Path.join(__dirname, "../workflows/hd-release.yml"), "utf8");
  Assert.match(workflow, /HD_SKIP_IF_PUBLISHED: \$\{\{ github\.event_name == 'schedule' \}\}/);
  Assert.match(workflow, /needs\.prepare\.outputs\.skip != 'true'/);
});

test("an already released scheduled commit skips before upstream and coverage checks", (t) => {
  const sha = "c".repeat(40);
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "hd-skip-"));
  t.after(() => Fs.rmSync(dir, { recursive: true, force: true }));
  const bin = Path.join(dir, "bin");
  Fs.mkdirSync(bin);
  const fork = [
    {
      tag_name: "v0.1.2-nightly.20261022.1",
      body: `Maintenance: ${sha}`,
      assets: [{ name: "T3-Code-x64.exe" }],
    },
  ];
  // Upstream has a newer, unmerged nightly; reaching it would fail the run.
  const upstream = [
    { tag_name: "v0.1.3-nightly.20261023.9", published_at: "2026-10-23T00:00:00Z" },
  ];
  Fs.writeFileSync(Path.join(dir, "fork.json"), JSON.stringify([fork]));
  Fs.writeFileSync(Path.join(dir, "upstream.json"), JSON.stringify([upstream]));
  Fs.writeFileSync(
    Path.join(bin, "gh"),
    `#!/bin/sh\ncase "$*" in *hack-dance/t3code-1/releases*) cat "${dir}/fork.json";; *) cat "${dir}/upstream.json";; esac\n`,
    { mode: 0o755 },
  );
  Fs.writeFileSync(
    Path.join(bin, "git"),
    `#!/bin/sh\n[ "$1" = rev-parse ] && echo ${sha} && exit 0\nexit 1\n`,
    { mode: 0o755 },
  );
  const output = Path.join(dir, "output");
  const result = ChildProcess.spawnSync(
    process.execPath,
    [Path.join(__dirname, "hd-release.cjs")],
    {
      cwd: dir,
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HD_MODE: "publish",
        HD_SOURCE: "head",
        HD_TARGETS: "pilot",
        HD_REQUIRE_LATEST_MERGED: "true",
        HD_SKIP_IF_PUBLISHED: "true",
        GITHUB_REPOSITORY: "hack-dance/t3code-1",
        GITHUB_RUN_ID: "42",
        GITHUB_OUTPUT: output,
      },
    },
  );
  Assert.equal(result.status, 0, result.stderr);
  Assert.equal(Fs.readFileSync(output, "utf8"), "skip=true\n");
  Assert.match(result.stdout, /already published as v0\.1\.2-nightly\.20261022\.1/);
});
