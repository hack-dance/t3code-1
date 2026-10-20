# Run lifecycle events

T3 Code can send metadata about thread turns to an HTTP webhook, a local command, or both. This works for turns started from any client, scheduled tasks, and app-owned delegated threads. It is disabled unless you configure a sink on the server that owns the threads.

Set `T3CODE_RUN_EVENTS_CONFIG` to the path of a JSON file before starting the server, then restart it. For example:

```sh
export T3CODE_RUN_EVENTS_CONFIG="$HOME/.config/t3/run-events.json"
```

```json
{
  "hostLabel": "workstation",
  "webhook": {
    "url": "https://example.com/run-events",
    "authHeaderEnv": "RUN_EVENTS_AUTH",
    "hmacSecretEnv": "RUN_EVENTS_SIGNING_KEY",
    "timeoutMs": 5000,
    "retries": 2,
    "backoffMs": 250
  },
  "command": {
    "executable": "/opt/hooks/run-event",
    "args": ["--format", "json"],
    "timeoutMs": 5000,
    "retries": 2,
    "backoffMs": 250
  }
}
```

Either sink can be omitted. An empty configuration is inactive. Remove the environment variable and restart to disable the feature. Invalid or unreadable configuration disables delivery and produces a generic warning without the file contents or path. Changes to the file require a restart.

`hostLabel` defaults to an empty string. T3 Code never substitutes the machine's hostname. Use a neutral label if you want to distinguish servers.

## Webhook

`url` must use HTTP or HTTPS; use HTTPS for remote receivers. Redirects are rejected. URL credentials are not accepted.

`authHeaderEnv` names a server environment variable containing the complete `Authorization` header value, including any scheme such as `Bearer`. `hmacSecretEnv` names a server environment variable containing the signing secret. These fields contain names, not secret values. Both are optional. If a configured variable is missing or empty, that delivery fails without sending an unauthenticated or unsigned request.

Requests use `POST` and `Content-Type: application/json`. When signing is configured, `X-T3-Signature-256` contains `sha256=` followed by the lowercase hexadecimal HMAC-SHA256 of the exact UTF-8 request body. Verify the signature against the raw body before parsing it, using a constant-time comparison. Retries reuse the body and event ID. Receivers should deduplicate by `eventId`; the signed body also contains the event timestamp.

## Command hook

`executable` is a program path or a program available on the server's `PATH`. `args` is an optional array of literal arguments. T3 Code does not invoke a shell or interpolate payload fields into arguments. Each invocation receives one JSON object followed by a newline on stdin. Exit code zero means success. Output is discarded.

Hooks inherit the server environment and working directory. Use an executable path if its location matters. A timed-out command is terminated. Hooks should finish promptly, avoid background processes, and deduplicate side effects by `eventId`, since a timeout can occur after a side effect succeeds.

## Payload

```json
{
  "type": "run.completed",
  "eventId": "t3:thread-a:run-a:finish",
  "timestamp": "2026-01-01T00:00:02.000Z",
  "threadId": "thread-a",
  "turnOrdinal": 1,
  "provider": "codex",
  "model": "model-a",
  "projectName": "Example project",
  "workspaceLabel": ".",
  "hostLabel": "workstation",
  "status": "completed",
  "durationMs": 2000
}
```

A logical turn emits `run.started` when it enters startup, before the provider begins work. Queued turns do not emit a start until promoted. The terminal event is `run.completed` for success or `run.failed` with status `failed`, `interrupted`, or `cancelled`. A queued turn cancelled before startup can emit a terminal event without a start. Provider retries and steering within the same logical turn share its start and terminal IDs. Rolling back history does not emit another completion.

`timestamp` is the lifecycle event time in UTC. `durationMs` is zero for starts; terminal duration is measured from provider start, or the request time if the provider never started. `turnOrdinal` is the app's run ordinal. `provider` is the engine/driver kind, or `unknown` if no longer available; it is not the user-defined provider instance name.

`workspaceLabel` is relative to the project root: `.` for the root, a relative path for a nested worktree, or `[worktree]` for a worktree outside the root. No absolute workspace path is sent. Project names, model names, and relative paths are sent as configured; choose those names with your receiver in mind. Prompts, message bodies, thread titles, tool output, errors, and generated summaries are never included.

## Delivery limits

Each sink has an independent in-memory queue of 256 notifications and processes it in order. Delivery never waits in the turn's execution path. A slow or failing sink cannot fail a turn or block the other sink.

Both sinks accept `timeoutMs` (default 5000, range 1–60000), `retries` (additional attempts, default 2, range 0–5), and `backoffMs` (default 250, range 1–10000). Delay doubles after each failure, capped at 30 seconds. Timeouts, non-success HTTP responses, and command failures use the same retry policy.

Delivery is best effort: queue overflow, exhausted retries, server shutdown, or a notification lookup failure can lose an event. Warnings omit payloads, credentials, and sink details. Pending events are not persisted or replayed after restart, and enabling the feature does not send historical events. Duplicate tracking is bounded to the latest 4096 lifecycle IDs; receivers should always deduplicate. This is suitable for notifications and automation that tolerate missed or repeated delivery, not an audit log.
