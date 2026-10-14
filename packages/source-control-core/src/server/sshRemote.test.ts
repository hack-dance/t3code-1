import { VcsProcessTimeoutError } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/process";
import { resolveSshRemoteUrl } from "./sshRemote.ts";

it.effect("resolves GitHub.com aliases and preserves other hosting endpoints", () =>
  Effect.gen(function* () {
    for (const [remoteUrl, hostname, expected] of [
      [
        "git@github.com-work:example/project.git",
        "github.com",
        "git@github.com:example/project.git",
      ],
      [
        "ssh://git@work:2222/example/project.git",
        "github.example.test",
        "ssh://git@work:2222/example/project.git",
      ],
      ["git@work:example/project.git", "gitlab.com", "git@work:example/project.git"],
      [
        "ssh://git@work:2222/group/../project%20name.git",
        "github.com",
        "ssh://git@github.com:2222/group/../project%20name.git",
      ],
      ["git@work:group/project name.git", "github.com", "git@github.com:group/project name.git"],
    ] as const) {
      const result = yield* resolveSshRemoteUrl({
        remoteUrl,
        cwd: "/repo",
        process: {
          run: () =>
            Effect.succeed({
              stdout: `hostname ${hostname}\n`,
              stderr: "",
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
        },
      });
      expect(result).toBe(expected);
    }
  }),
);

it.effect("leaves HTTPS remotes alone and keeps SSH URLs when resolution fails", () =>
  Effect.gen(function* () {
    const remoteUrl = "https://github.com-work/example/project.git";
    const result = yield* resolveSshRemoteUrl({
      remoteUrl,
      cwd: "/repo",
      process: { run: () => Effect.die("HTTPS must not invoke ssh") },
    });
    expect(result).toBe(remoteUrl);
    const ssh = "git@github.com-work:example/project.git";
    expect(
      yield* resolveSshRemoteUrl({
        remoteUrl: ssh,
        cwd: "/repo",
        process: {
          run: () =>
            Effect.fail(
              new VcsProcessTimeoutError({
                operation: "test",
                command: "ssh",
                cwd: "/repo",
                timeoutMs: 5000,
              }),
            ),
        },
      }),
    ).toBe(ssh);
  }),
);

it.effect("keeps the original remote when SSH has no usable hostname", () =>
  Effect.gen(function* () {
    const remoteUrl = "ssh://git@work:2222/example/project.git";
    for (const [stdout, exitCode] of [
      ["user git\n", 0],
      ["hostname -bad-host\n", 0],
      ["hostname github.com\n", 1],
    ] as const) {
      expect(
        yield* resolveSshRemoteUrl({
          remoteUrl,
          cwd: "/repo with spaces",
          process: {
            run: () =>
              Effect.succeed({
                stdout,
                stderr: "",
                exitCode: ChildProcessSpawner.ExitCode(exitCode),
                stdoutTruncated: false,
                stderrTruncated: false,
              }),
          },
        }),
      ).toBe(remoteUrl);
    }
  }),
);

it.effect("reads the SSH URL's user, alias, and transport port", () =>
  Effect.gen(function* () {
    const remoteUrl = "ssh://git@github.com-work:2222/example/project.git";
    const result = yield* resolveSshRemoteUrl({
      remoteUrl,
      cwd: "/repo with spaces",
      process: {
        run: (input) => {
          expect(input.args).toEqual(["-G", "-l", "git", "-p", "2222", "github.com-work"]);
          return Effect.succeed({
            stdout: "hostname github.com\n",
            stderr: "",
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdoutTruncated: false,
            stderrTruncated: false,
          });
        },
      },
    });
    expect(result).toBe("ssh://git@github.com:2222/example/project.git");
  }),
);

it.effect("keeps public API hosts when SSH uses an alternate endpoint or IP address", () =>
  Effect.gen(function* () {
    for (const hostname of ["github.com", "gitlab.com", "bitbucket.org"]) {
      const remoteUrl = `git@${hostname}:example/project.git`;
      expect(
        yield* resolveSshRemoteUrl({
          remoteUrl,
          cwd: "/repo",
          process: { run: () => Effect.die("Known API hosts do not need SSH resolution") },
        }),
      ).toBe(remoteUrl);
    }
    for (const [hostname, expectedHost] of [
      ["ssh.github.com", "github.com"],
      ["altssh.gitlab.com", "work"],
      ["altssh.bitbucket.org", "work"],
      ["ssh.github.example.test", "work"],
      ["gitea.example.test", "work"],
      ["192.0.2.1", "work"],
    ]) {
      expect(
        yield* resolveSshRemoteUrl({
          remoteUrl: "git@work:example/project.git",
          cwd: "/repo",
          process: {
            run: () =>
              Effect.succeed({
                stdout: `hostname ${hostname}\r\n`,
                stderr: "",
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdoutTruncated: false,
                stderrTruncated: false,
              }),
          },
        }),
      ).toBe(`git@${expectedHost}:example/project.git`);
    }
  }),
);
