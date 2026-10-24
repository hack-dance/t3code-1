import {
  approvalRequestExpiresAt,
  ProviderRequestKind,
  type CommandId,
  type RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type RunId,
  OrchestratorMcpFailure,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { approvalActionDigest } from "../../../orchestration-v2/ApprovalAction.ts";
import * as DateTime from "effect/DateTime";
import { modelSelectionCommandType } from "@t3tools/shared/model";

import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  assertFullAccess,
  dispatchFailure,
  newCommandId,
  readCaller,
  readThread,
  unavailable,
} from "../../threadAccess.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTasks from "../../../scheduledTasks/ScheduledTaskService.ts";
import { queuedRunsInDeliveryOrder } from "../../../orchestration-v2/QueuedRunOrder.ts";
import { ThreadToolkit } from "./tools.ts";

function queueEntry(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  runId: RunId,
  limit: number,
) {
  const run = projection.runs.find((run) => run.id === runId && run.status === "queued");
  const message = projection.messages.find((message) => message.id === run?.userMessageId);
  if (run === undefined || message === undefined) return undefined;
  const characters = Array.from(message.text);
  return {
    queuedRunId: run.id,
    text: characters.slice(0, limit).join(""),
    truncated: characters.length > limit,
  };
}
const dispatch = Effect.fn("mcp.dispatchThreadCommand")(function* (
  threadId: ThreadId | undefined,
  command: (common: { commandId: CommandId; threadId: ThreadId }) => OrchestrationV2Command,
) {
  const { threads, projection } = yield* readThread(threadId);
  const result = yield* threads
    .dispatch(command({ commandId: yield* newCommandId(), threadId: projection.thread.id }))
    .pipe(Effect.mapError(dispatchFailure));
  return { sequence: result.sequence };
});

const readPendingRequest = Effect.fn("mcp.readQuestion")(function* (input: {
  threadId?: ThreadId | undefined;
  requestId: RuntimeRequestId;
}) {
  const context = yield* readThread(input.threadId, ["runtimeRequests", "turnItems"]);
  const request = context.projection.runtimeRequests.find(
    (request) => request.id === input.requestId,
  );
  if (request === undefined)
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "The pending runtime request was not found.",
    });
  if (request.status !== "pending")
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        request.kind === "user_input" && request.status === "resolved"
          ? "The user-input request was already answered."
          : `The runtime request is no longer pending (${request.status}).`,
    });
  const item = context.projection.turnItems.find(
    (item) =>
      (item.type === "user_input_request" || item.type === "approval_request") &&
      item.requestId === request.id,
  );
  if (
    (item?.type !== "user_input_request" || request.kind !== "user_input") &&
    (item?.type !== "approval_request" || request.kind !== item.requestKind)
  )
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "The runtime request has no matching question or approval details.",
    });
  return { ...context, request, item };
});
const writesThread = <P extends { readonly threadId?: ThreadId | undefined }, A, E, R>(
  handle: (params: P) => Effect.Effect<A, E, R>,
) => McpToolAccess.writesThreads((params: P) => [params.threadId], handle);

export const layer = McpToolAccess.toLayer(ThreadToolkit, {
  run_scheduled_task_now: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const scheduler = yield* ScheduledTasks.ScheduledTaskService;
      const { tasks } = yield* scheduler.list().pipe(Effect.mapError(unavailable));
      if (!tasks.some((task) => task.id === input.taskId))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The scheduled task was not found.",
        });
      const { task, threadId } = yield* scheduler
        .runNow({ id: input.taskId })
        .pipe(Effect.mapError(unavailable));
      return {
        taskId: task.id,
        threadId,
        lastRunStatus: task.lastRunStatus,
        runCount: task.runCount,
        nextRunAt: task.nextRunAt,
      };
    }),
  ),
  t3_thread_search: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { caller } = yield* readCaller();
      const { projectId: requested, ...query } = input;
      const projectId = requested ?? caller?.projectId;
      const threadSearch = yield* ThreadSearch.ThreadSearch;
      const result = yield* threadSearch.search(query).pipe(Effect.mapError(unavailable));
      return {
        matches:
          projectId === undefined
            ? result.matches
            : result.matches.filter((match) => match.projectId === projectId),
      };
    }),
  ),
  t3_thread_fork: writesThread((input) =>
    Effect.gen(function* () {
      const { threads, projection } = yield* readThread(input.threadId);
      const commandId = yield* newCommandId();
      const targetThreadId = ThreadId.make(`${commandId}:fork`);
      const result = yield* threads
        .dispatch({
          type: "thread.fork",
          commandId,
          sourceThreadId: projection.thread.id,
          targetThreadId,
          sourcePoint: input.sourcePoint,
          ...(input.title === undefined ? {} : { title: input.title }),
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(Effect.mapError(dispatchFailure));
      return { sequence: result.sequence, targetThreadId };
    }),
  ),
  t3_thread_merge_back: McpToolAccess.writesThreads(
    (input) => [input.targetThreadId, input.sourceThreadId],
    (input) =>
      Effect.gen(function* () {
        const context = yield* readThread(input.targetThreadId);
        const source = yield* readThread(input.sourceThreadId);
        const result = yield* context.threads
          .dispatch({
            type: "thread.merge_back",
            commandId: yield* newCommandId(),
            sourceThreadId: source.projection.thread.id,
            targetThreadId: input.targetThreadId,
            sourcePoint: input.sourcePoint,
            createdBy: "agent",
            creationSource: "mcp",
          })
          .pipe(Effect.mapError(dispatchFailure));
        return { sequence: result.sequence, targetThreadId: input.targetThreadId };
      }),
  ),
  t3_thread_transfers: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId, ["contextTransfers"]);
      return {
        transfers: projection.contextTransfers.map(
          ({ id, sourceThreadId, targetThreadId, status }) => ({
            id,
            sourceThreadId,
            targetThreadId,
            status,
          }),
        ),
      };
    }),
  ),
  t3_thread_configuration: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const {
        projection: { thread },
      } = yield* readThread(input.threadId);
      return {
        threadId: thread.id,
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        ...(thread.claudeToolPolicy === undefined
          ? {}
          : { claudeToolPolicy: thread.claudeToolPolicy }),
      };
    }),
  ),
  t3_thread_configure: writesThread((input) =>
    Effect.gen(function* () {
      const {
        threads,
        projection: { thread },
      } = yield* readThread(input.threadId);
      const type = modelSelectionCommandType(thread.providerInstanceId, input.modelSelection);
      const result = yield* threads
        .dispatch({
          type,
          threadId: thread.id,
          commandId: yield* newCommandId(),
          modelSelection: input.modelSelection,
        })
        .pipe(Effect.mapError(dispatchFailure));
      return { sequence: result.sequence };
    }),
  ),
  t3_pending_request_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId, ["runtimeRequests"]);
      const requests = projection.runtimeRequests
        .filter(
          (request) =>
            request.status === "pending" &&
            (request.kind === "user_input" ||
              ProviderRequestKind.literals.some((kind) => kind === request.kind)),
        )
        .map(({ id, kind }) => ({ id, kind }));
      return {
        requestIds: requests.map(({ id }) => id),
        requests,
      };
    }),
  ),
  t3_pending_request_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { item, request } = yield* readPendingRequest(input);
      if (item.type === "user_input_request")
        return { requestId: input.requestId, questions: item.questions };
      return {
        requestId: input.requestId,
        kind: item.requestKind,
        actionDigest: approvalActionDigest(request),
        ...(request.action === undefined ? {} : { action: request.action }),
        ...(approvalRequestExpiresAt(request) === null
          ? {}
          : { expiresAt: approvalRequestExpiresAt(request)! }),
        ...(item.prompt === undefined ? {} : { prompt: item.prompt }),
        ...(item.reason === undefined ? {} : { reason: item.reason }),
        ...(item.fullAccessOverride === undefined
          ? {}
          : { fullAccessOverride: item.fullAccessOverride }),
        ...(item.appName === undefined ? {} : { appName: item.appName }),
        ...(item.options === undefined ? {} : { options: item.options }),
      };
    }),
  ),
  t3_pending_request_respond: writesThread((input) =>
    Effect.gen(function* () {
      const context = yield* readPendingRequest(input);
      const { threads, projection, request } = context;
      const expiresAt = approvalRequestExpiresAt(request);
      if (
        expiresAt !== null &&
        DateTime.toEpochMillis(yield* DateTime.now) >= expiresAt &&
        input.decision !== "decline" &&
        input.decision !== "cancel"
      )
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "This approval expired after 4 hours. Decline or cancel it, then request a new approval in the thread.",
        });
      if (input.expectRequestKind !== undefined && input.expectRequestKind !== request.kind)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `Expected request kind ${input.expectRequestKind}, but found ${request.kind}.`,
        });
      if (request.responseCapability.type === "not_resumable")
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The runtime request is stale and can no longer be resumed.",
        });
      if (request.kind === "user_input") {
        if (input.decision !== undefined || input.answers === undefined)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "User-input requests require answers and do not accept a decision.",
          });
      } else if (input.answers !== undefined || input.decision === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Approval requests require a decision and do not accept answers.",
        });
      }
      if (
        input.decision === "accept" ||
        input.decision === "acceptForSession" ||
        input.decision === "acceptAlways"
      ) {
        if (
          context.item.type === "approval_request" &&
          (context.item.options === undefined
            ? input.decision === "acceptAlways"
            : !context.item.options.some((option) => option.decision === input.decision))
        ) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "This approval does not support the requested decision.",
          });
        }
        yield* assertFullAccess(
          context,
          "Granting approvals needs a live full-access/default calling thread or a full-access client.",
        );
      }
      const result = yield* threads
        .dispatch({
          type: "runtime-request.respond",
          ...(input.expectActionDigest === undefined
            ? {}
            : { expectActionDigest: input.expectActionDigest }),
          threadId: projection.thread.id,
          commandId: yield* newCommandId(),
          requestId: input.requestId,
          ...(input.answers === undefined ? {} : { answers: input.answers }),
          ...(input.decision === undefined ? {} : { decision: input.decision }),
        })
        .pipe(Effect.mapError(dispatchFailure));
      return { sequence: result.sequence };
    }),
  ),
  t3_queue_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId, ["runs", "messages"]);
      const runs = queuedRunsInDeliveryOrder(projection);
      const cursor = input.cursor ?? 0;
      const end = cursor + (input.limit ?? 20);
      return {
        items: runs.slice(cursor, end).flatMap((run) => {
          const entry = queueEntry(projection, run.id, 1000);
          return entry === undefined ? [] : [entry];
        }),
        nextCursor: end < runs.length ? end : null,
      };
    }),
  ),
  t3_queue_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId, ["runs", "messages"]);
      const entry = queueEntry(projection, input.queuedRunId, 16000);
      return (
        entry ??
        (yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The queued message was not found.",
        }))
      );
    }),
  ),
  t3_queue_edit: writesThread((input) =>
    dispatch(input.threadId, (common) => ({
      ...common,
      type: "queued-run.edit",
      runId: input.queuedRunId,
      text: input.text,
    })),
  ),
  t3_queue_cancel: writesThread((input) =>
    dispatch(input.threadId, (common) => ({
      ...common,
      type: "queued-run.cancel",
      runId: input.queuedRunId,
    })),
  ),
  t3_queue_reorder: writesThread((input) =>
    dispatch(input.threadId, (common) => ({
      ...common,
      type: "queued-run.reorder",
      runId: input.queuedRunId,
      beforeRunId: input.beforeRunId,
    })),
  ),
  t3_queue_promote_to_steer: writesThread((input) =>
    dispatch(input.threadId, (common) => ({
      ...common,
      type: "queued-message.promote-to-steer",
      queuedRunId: input.queuedRunId,
      targetRunId: input.targetRunId,
    })),
  ),
  t3_thread_organize: writesThread((input) =>
    Effect.gen(function* () {
      const { threads, projection, caller } = yield* readThread(input.threadId);
      const common = { commandId: yield* newCommandId(), threadId: projection.thread.id };
      if (input.action === "settle") {
        return yield* threads
          .settleThread({ ...common, byOwnAgent: caller?.id === projection.thread.id })
          .pipe(Effect.mapError(dispatchFailure));
      }
      let command: OrchestrationV2Command;
      switch (input.action) {
        case "snooze":
          if (input.snoozedUntil === undefined) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "snooze requires snoozedUntil.",
            });
          }
          command = { ...common, type: "thread.snooze", snoozedUntil: input.snoozedUntil };
          break;
        case "unsnooze":
        case "unsettle":
          command = { ...common, type: `thread.${input.action}`, reason: "user" };
          break;
        case "mark_unread":
          command = { ...common, type: "thread.mark-unread" };
          break;
        default:
          command = { ...common, type: `thread.${input.action}` };
      }
      const result = yield* threads.dispatch(command).pipe(Effect.mapError(dispatchFailure));
      return { sequence: result.sequence };
    }),
  ),
});
