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
    "providerInstanceIds": ["provider-a"],
    "projectIds": ["project-a"],
    "authHeaderEnv": "RUN_EVENTS_AUTH",
    "hmacSecretEnv": "RUN_EVENTS_SIGNING_KEY",
    "timeoutMs": 5000,
    "retries": 2,
    "backoffMs": 250
  },
  "command": {
    "executable": "/opt/hooks/run-event",
    "providerInstanceIds": ["provider-a"],
    "projectIds": ["project-a"],
    "args": ["--format", "json"],
    "timeoutMs": 5000,
    "retries": 2,
    "backoffMs": 250
  }
}
```

Either sink can be omitted. An empty configuration is inactive. Remove the environment variable and restart to disable the feature. Invalid or unreadable configuration disables delivery and produces a generic warning without the file contents or path. Changes to the file require a restart.

`hostLabel` defaults to an empty string. T3 Code never substitutes the machine's hostname. Use a neutral label if you want to distinguish servers.

## Sink selection

Each sink requires matching `providerInstanceIds` and `projectIds` allowlists before it receives any event. Both conditions must match; missing or empty lists match nothing. Existing configurations without these lists now deliver nothing until you select their scope. Use the opaque IDs from your server’s provider configuration and project records, not display names or engine names.

Lists are independent per sink. Two provider instances using the same engine can be routed separately. Provider filtering happens before metadata lookup, and project filtering happens before building or queuing the payload. No account classification or provider-instance label is sent to the receiver.

## Webhook

`url` must use HTTP or HTTPS; use HTTPS for remote receivers. Redirects are rejected. URL credentials are not accepted. HTTP request tracing is disabled so endpoint paths, query parameters, and credential headers do not enter spans.

`authHeaderEnv` names a server environment variable containing the complete `Authorization` header value, including any scheme such as `Bearer`. `hmacSecretEnv` names a server environment variable containing the signing secret. These fields contain names, not secret values. Both are optional. If a configured variable is missing or empty, that delivery fails without sending an unauthenticated or unsigned request.

Requests use `POST` and `Content-Type: application/json`. When signing is configured, `X-T3-Signature-256` contains `sha256=` followed by the lowercase hexadecimal HMAC-SHA256 of the exact UTF-8 request body. Verify the signature against the raw body before parsing it, using a constant-time comparison. Retries reuse the body and event ID. Receivers should deduplicate by `eventId`; the signed body also contains the event timestamp.

## Command hook

`executable` is a program path or a program available on the server's `PATH`. `args` is an optional array of literal arguments. T3 Code does not invoke a shell or interpolate payload fields into arguments. Each invocation receives one JSON object followed by a newline on stdin. Exit code zero means success. Output is discarded.

Hooks inherit the server environment and working directory. Use an executable path if its location matters. A timed-out command is terminated. Hooks should finish promptly, avoid background processes, and deduplicate side effects by `eventId`, since a timeout can occur after a side effect succeeds.

## Payload

```json
{
  "type": "run.completed",
  "eventId": "t3:thread-a:run-a:finish:completed:1767225602000",
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

A logical turn emits `run.started` when it enters startup, before the provider begins work. Queued turns do not emit a start until promoted. The terminal event is `run.completed` for success or `run.failed` with status `failed`, `interrupted`, or `cancelled`. A terminal event can arrive without a start when a queued turn is cancelled, workspace preparation fails, or recovery interrupts an existing turn after a server restart.

A logical turn has one start ID. Terminal IDs include the outcome and completion timestamp. If workspace preparation fails and is retried with the same run ID, a later success or failure produces a new terminal revision with a distinct ID. Repeated updates for the same terminal revision, and delivery retries, keep the same ID. Provider retries and steering that do not settle the run do not create additional lifecycle notifications. Rolling back history does not emit another completion.

`timestamp` is the lifecycle event time in UTC. `durationMs` is zero for starts; terminal duration is measured from provider start, or the request time if the provider never started. `turnOrdinal` is the app's run ordinal. `provider` is the engine/driver kind, or `unknown` if no longer available; it is not the user-defined provider instance name.

`workspaceLabel` is relative to the project root: `.` for the root, a relative path for a nested worktree, or `[worktree]` for a worktree outside the root. No absolute workspace path is sent. Project names, model names, and relative paths are sent as configured; choose those names with your receiver in mind. Prompts, message bodies, thread titles, tool output, errors, and generated summaries are never included.

## Delivery limits

Each sink has an independent in-memory queue of 256 notifications and processes it in order. Delivery never waits in the turn's execution path. A slow or failing sink cannot fail a turn or block the other sink.

Both sinks accept `timeoutMs` (default 5000, range 1–60000), `retries` (additional attempts, default 2, range 0–5), and `backoffMs` (default 250, range 1–10000). Delay doubles after each failure, capped at 30 seconds. Timeouts, transport failures, HTTP 408/429/5xx responses, and command failures are retried. Other HTTP rejections and missing configured credentials are not retried, so a permanent failure does not hold up later events.

Delivery is best effort: queue overflow, exhausted retries, server shutdown, or a notification lookup failure can lose an event. Warnings omit payloads, credentials, and sink details. Pending events are not persisted or replayed after restart, and enabling the feature does not send historical events. Duplicate tracking keeps one entry per run and retains the 4096 most recently observed runs. Repeated updates refresh that entry, so an active run is not evicted just because it started earlier. Once an entry is evicted, a later update can repeat a start or terminal event; receivers should always deduplicate by event ID. A failed metadata lookup is attempted once per lifecycle notification, then skipped until another lifecycle notification occurs. This is suitable for notifications and automation that tolerate missed or repeated delivery, not an audit log.
