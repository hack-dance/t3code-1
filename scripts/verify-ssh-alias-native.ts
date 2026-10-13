import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as Effect from "../packages/source-control-github/node_modules/effect/dist/Effect.js";
import * as Layer from "../packages/source-control-github/node_modules/effect/dist/Layer.js";
import * as NodeServices from "../packages/source-control-github/node_modules/@effect/platform-node/dist/NodeServices.js";
import * as Credentials from "../packages/source-control-github/src/server/GitHubCredentials.ts";
import * as TestHost from "../packages/source-control-testing/src/TestSourceControlHost.ts";
import { resolveSshRemoteUrl } from "../packages/source-control-core/src/server/sshRemote.ts";

const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "t3-native-ssh-"));
const cwd = join(root, "repo with spaces ü");
await mkdir(cwd);
const config = join(root, "SSH configuration ü");
await writeFile(config, "Host github.com-work github.com-personal\r\n  HostName github.com\r\n  User git\r\n");
await exec("git", ["init", "-q", cwd]);
await exec("git", ["-C", cwd, "config", "--local", "github.user", "fake-work"]);
let accountRequested = false;
const run = (input) => Effect.tryPromise({
  try: async () => {
    if (input.command === "gh") {
      assert.deepEqual(input.args, ["auth", "token", "--hostname", "github.com", "--user", "fake-work"]);
      accountRequested = true;
      return { stdout: "fake-token", stderr: "", exitCode: 0, stdoutTruncated: false, stderrTruncated: false };
    }
    const args = input.command === "ssh" ? ["-F", config, ...input.args] : input.args;
    const { stdout, stderr } = await exec(input.command, args, { cwd: input.cwd, timeout: 10000 });
    return { stdout, stderr, exitCode: 0, stdoutTruncated: false, stderrTruncated: false };
  },
  catch: () => new Error("Native process proof failed"),
});
const host = TestHost.layer({ process: { run }, git: {
  readConfigValue: (dir, key) => run({ command: "git", args: ["config", "--get", key], cwd: dir }).pipe(Effect.map(r => r.stdout.trim())),
}});
const dependencies = Layer.mergeAll(host, NodeServices.layer);
await Effect.runPromise(Effect.gen(function* () {
  for (const remoteUrl of ["git@github.com-work:acme/demo.git", "git@github.com-personal:acme/demo.git", "ssh://git@github.com-work:2222/acme/demo%20name.git"]) {
    const resolved = yield* resolveSshRemoteUrl({ remoteUrl, cwd, process: { run } });
    assert.equal(resolved, remoteUrl.replace(/github\.com-(work|personal)/, "github.com"));
  }
  const credentials = yield* Credentials.make;
  yield* credentials.get("github.com").pipe(Effect.provideService(Credentials.RepositoryDirectory, cwd));
  assert.equal(accountRequested, true);
}).pipe(Effect.provide(dependencies)));
console.log(JSON.stringify({ platform: process.platform, nativeSshAliasesResolved: true, sshUrlPortPreserved: true, nativeGitAccountRead: true, spacesAndUnicodePath: true, ghUserArgumentCheckedWithFakeCredential: true }));
