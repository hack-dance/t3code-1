const Assert = require("node:assert/strict");
const ChildProcess = require("node:child_process");
const Fs = require("node:fs");
const Os = require("node:os");
const Path = require("node:path");
const { test } = require("node:test");
const { selectRelease, releaseVersion, prepareCandidate } = require("./hd-release.cjs");

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
