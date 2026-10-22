# Project transfer event hooks

Use event hooks to notify your own tools when **Add to another machine** clones a
project or copies its ignored files. Hooks are off by default.

On the destination environment, set `T3CODE_EVENT_HOOKS_CONFIG` to the path of a
JSON configuration file, such as `~/.config/t3/event-hooks.json`. Expand `~` when
setting the environment variable. Restart that environment's T3 server after
changing the configuration.

```json
{
  "timeoutMs": 3000,
  "webhook": {
    "url": "https://example.com/events",
    "header": {
      "name": "Authorization",
      "env": "PROJECT_EVENT_AUTH"
    }
  },
  "command": {
    "executable": "project-event-hook",
    "args": ["--format", "json"]
  }
}
```

Configure either `webhook`, `command`, or both. `timeoutMs` applies separately to
each delivery; it defaults to 3000 and accepts integers from 1 through 60000.
An unreadable or invalid configuration disables delivery. If the environment
variable is set, clients still send reports, which the server discards.

The webhook receives an HTTP POST with `Content-Type: application/json`. The
optional `header` takes its entire value from the named environment variable in
the destination server's process. For example, an Authorization header's value
can include its `Bearer ` prefix. If the variable is missing or empty, that
webhook is skipped. Redirects are refused.

The command runs on the destination machine with the server's permissions,
working directory, and environment. Its executable and arguments are passed
directly, without a shell or interpolation. It receives one JSON object followed
by a newline on stdin. Its stdout and stderr are discarded. Use an executable
on the server's PATH or an absolute executable path.

Events have this shape:

```json
{
  "type": "files.copied",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "source": { "label": "host-a" },
  "target": { "label": "build-box" },
  "repo": {
    "projectName": "example-project",
    "remoteUrl": "https://example.com/team/project.git"
  },
  "destinationPath": "/workspace/project",
  "files": [".env", "config/.env.local"]
}
```

- `clone.started` is emitted for each accepted remote clone attempt, including
  retries. Requests rejected before a clone starts do not emit an event.
- `clone.completed` means Git finished successfully.
- `clone.failed` means the running clone failed or was cancelled.
- `files.copied` is emitted once after the selected file writes finish, if at
  least one succeeded. It lists only successfully copied paths, relative to the
  destination checkout. Partial copies omit failed files. Clone events have an
  empty `files` array.

The transfer flow includes file names, never file contents or raw error messages.
Remote URLs lose their username, password, query string, and fragment. Malformed
or ambiguous forms are omitted, including scheme URLs without an explicit host.
Labels, project names, destination paths, and relative file names are metadata
sent to your configured hooks.

Delivery is best effort: it does not delay or fail the clone or copy. Both hooks
run independently, timed-out commands are killed, and hook failures are ignored.
There are no retries or persistent queue. At most 32 events are in flight per
server; additional events are dropped and counted in debug logs. Delivery order
is not guaranteed, and server shutdown can interrupt delivery.

Copied-file reports allow 200 file names of up to 512 characters each. Labels and
project names allow 256 characters, destination paths 4096, and remote URLs 8192.
Oversized reports are rejected without affecting the copy.

Web and desktop support this transfer flow. Ordinary clones, including the
mobile add-project flow, do not emit transfer events. Closing or disconnecting
the client before it reports copied files can lose that event.

Reports are not an audit log: anyone with `filesystem:write` permission can supply
arbitrary metadata. Treat event fields as untrusted input in your hooks. Hook
commands and URLs always come from your server configuration.

Older destination servers without transfer-event support skip copied-file reporting.
See [remote access](./remote-access.md) for connecting environments and
[source control](./source-control.md) for cloning repositories.
