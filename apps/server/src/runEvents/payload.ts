import type { OrchestrationV2Run } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import type * as Path from "effect/Path";

export const RunEvent = Schema.Struct({
  type: Schema.Literals(["run.started", "run.completed", "run.failed"]),
  eventId: Schema.String,
  timestamp: Schema.String,
  threadId: Schema.String,
  turnOrdinal: Schema.Number,
  provider: Schema.String,
  model: Schema.String,
  projectName: Schema.String,
  workspaceLabel: Schema.String,
  hostLabel: Schema.String,
  status: Schema.Literals(["started", "completed", "failed", "interrupted", "cancelled"]),
  durationMs: Schema.Number,
});
export type RunEvent = typeof RunEvent.Type;

export function lifecycleStatus(run: OrchestrationV2Run): RunEvent["status"] | undefined {
  switch (run.status) {
    case "starting":
    case "running":
    case "waiting":
      return "started";
    case "completed":
    case "failed":
    case "interrupted":
    case "cancelled":
      return run.status;
    default:
      return undefined;
  }
}

export function workspaceLabel(path: Path.Path, root: string, worktree: string | null): string {
  if (!worktree) return ".";
  const relative = path.relative(root, worktree);
  // External worktrees must not disclose ancestors outside the project root.
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
    ? "[worktree]"
    : relative.split(path.sep).join("/") || ".";
}

export function createPayload(input: {
  run: OrchestrationV2Run;
  status: RunEvent["status"];
  occurredAt: DateTime.Utc;
  provider: string;
  projectName: string;
  workspaceLabel: string;
  hostLabel: string;
}): RunEvent {
  const { run, status } = input;
  const type =
    status === "started" ? "run.started" : status === "completed" ? "run.completed" : "run.failed";
  const timestamp = status === "started" ? input.occurredAt : (run.completedAt ?? input.occurredAt);
  return {
    type,
    // One start and one terminal notification per logical run, including provider retries.
    eventId: `t3:${run.threadId}:${run.id}:${status === "started" ? "start" : "finish"}`,
    timestamp: DateTime.formatIso(timestamp),
    threadId: run.threadId,
    turnOrdinal: run.ordinal,
    provider: input.provider,
    model: run.modelSelection.model,
    projectName: input.projectName,
    workspaceLabel: input.workspaceLabel,
    hostLabel: input.hostLabel,
    status,
    durationMs:
      status === "started"
        ? 0
        : Math.max(
            0,
            DateTime.toEpochMillis(timestamp) -
              DateTime.toEpochMillis(run.startedAt ?? run.requestedAt),
          ),
  };
}
