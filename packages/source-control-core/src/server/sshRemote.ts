import * as Effect from "effect/Effect";
import { isSshRemoteUrl } from "@t3tools/shared/sourceControl";
import type * as SourceControlHost from "./SourceControlHost.ts";

const SSH_HOSTNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u;
const PUBLIC_HOSTS = new Set([
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "codeberg.org",
  "ssh.dev.azure.com",
]);

/** Keeps the original repository path when replacing the host. */
function parseSshRemote(remoteUrl: string) {
  const value = remoteUrl.trim();

  if (value.toLowerCase().startsWith("ssh://")) {
    const url = URL.parse(value);
    if (url === null) return null;

    const authorityStart = "ssh://".length;
    const pathStart = value.indexOf("/", authorityStart);
    const authority = value.slice(authorityStart, pathStart === -1 ? undefined : pathStart);
    const hostnameStart = authorityStart + authority.lastIndexOf("@") + 1;

    return {
      hostname: url.hostname,
      username: url.username,
      port: url.port,
      prefix: value.slice(0, hostnameStart),
      suffix: value.slice(hostnameStart + url.hostname.length),
    };
  }

  const userEnd = value.indexOf("@");
  const hostnameEnd = value.indexOf(":", userEnd + 1);
  if (userEnd === -1 || hostnameEnd === -1) return null;

  return {
    hostname: value.slice(userEnd + 1, hostnameEnd),
    username: value.slice(0, userEnd),
    port: "",
    prefix: value.slice(0, userEnd + 1),
    suffix: value.slice(hostnameEnd),
  };
}

function readSshHostname(stdout: string) {
  for (const line of stdout.split("\n")) {
    const [key, value] = line.trim().split(/\s+/u);
    if (key?.toLowerCase() === "hostname") return value;
  }
}

/** Resolves github.com SSH aliases for API lookup. Other hosts keep their existing routing. */
export const resolveSshRemoteUrl = Effect.fn("resolveSshRemoteUrl")(function* (input: {
  readonly remoteUrl: string;
  readonly cwd: string;
  readonly process: SourceControlHost.SourceControlHost["Service"]["process"];
}) {
  if (!isSshRemoteUrl(input.remoteUrl)) return input.remoteUrl;

  const remote = parseSshRemote(input.remoteUrl);
  // Accept host names and aliases. Reject values that SSH can treat as command options.
  if (remote === null || !SSH_HOSTNAME_PATTERN.test(remote.hostname)) return input.remoteUrl;
  // A public API host can use a different SSH endpoint, such as GitHub's port-443 host.
  if (PUBLIC_HOSTS.has(remote.hostname.toLowerCase())) return input.remoteUrl;

  const output = yield* input.process
    .run({
      operation: "source-control.resolve-ssh-host",
      command: "ssh",
      args: [
        "-G",
        ...(remote.username ? ["-l", remote.username] : []),
        ...(remote.port ? ["-p", remote.port] : []),
        remote.hostname,
      ],
      cwd: input.cwd,
      timeoutMs: 5_000,
      maxOutputBytes: 64_000,
    })
    .pipe(Effect.orElseSucceed(() => null));

  const resolvedHostname =
    output?.exitCode === 0 ? readSshHostname(output.stdout)?.toLowerCase() : undefined;
  if (resolvedHostname !== "github.com" && resolvedHostname !== "ssh.github.com")
    return input.remoteUrl;

  return `${remote.prefix}github.com${remote.suffix}`;
});
