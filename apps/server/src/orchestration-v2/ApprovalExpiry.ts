import {
  approvalRequestExpiresAt,
  CommandId,
  EventId,
  type OrchestrationV2DomainEvent,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

class ApprovalExpiryError extends Schema.TaggedError<ApprovalExpiryError>()("ApprovalExpiryError", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "Failed to expire pending approvals.";
  }
}

export class ApprovalExpiry extends Context.Service<
  ApprovalExpiry,
  {
    readonly sweep: Effect.Effect<void, ApprovalExpiryError>;
  }
>()("t3/orchestration-v2/ApprovalExpiry") {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sink = yield* EventSink.EventSinkV2;
  const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const expire = Effect.fn("ApprovalExpiry.expire")(function* (
    threadId: ThreadId,
    requestId: RuntimeRequestId,
  ) {
    // Responses use this same lock. Re-read so a sweep cannot overwrite an accepted request.
    yield* executor.withLock(
      threadId,
      Effect.gen(function* () {
        const context = yield* projections.getRuntimeResponseContext(threadId, requestId);
        const request = context.request;
        if (request === undefined || request.status !== "pending") return;
        const now = yield* DateTime.now;
        const deadline = approvalRequestExpiresAt(request);
        if (deadline === null || deadline > DateTime.toEpochMillis(now)) return;
        const commandId = CommandId.make(`approval-expiry:${threadId}:${requestId}`);
        const base = {
          threadId,
          nodeId: request.nodeId,
          ...(context.node?.runId == null ? {} : { runId: context.node.runId }),
          ...(context.session === undefined
            ? {}
            : {
                driver: context.session.driver,
                providerInstanceId: context.session.providerInstanceId,
              }),
          occurredAt: now,
        };
        const events: OrchestrationV2DomainEvent[] = [
          {
            ...base,
            id: EventId.make(`${commandId}:request`),
            type: "runtime-request.updated",
            payload: { ...request, status: "expired", resolvedAt: now, decision: "decline" },
          },
        ];
        if (context.node)
          events.push({
            ...base,
            id: EventId.make(`${commandId}:node`),
            type: "node.updated",
            payload: { ...context.node, status: "cancelled", completedAt: now },
          });
        if (context.item)
          events.push({
            ...base,
            id: EventId.make(`${commandId}:item`),
            type: "turn-item.updated",
            payload: {
              ...context.item,
              status: "cancelled",
              completedAt: now,
              updatedAt: now,
              title: "Approval expired after 4 hours",
            },
          });
        yield* sink.writeWithEffects({
          commandId,
          events,
          // Decline the suspended provider callback so expiry does not leave the agent stuck.
          effects:
            request.responseCapability.type === "live"
              ? [
                  {
                    id: `effect:${commandId}:decline`,
                    commandId,
                    threadId,
                    request: {
                      type: "runtime-request.respond",
                      requestId,
                      providerSessionId: request.responseCapability.providerSessionId,
                      decision: "decline",
                    },
                  },
                ]
              : [],
        });
      }),
    );
  });
  return ApprovalExpiry.of({
    sweep: Effect.gen(function* () {
      const now = yield* DateTime.now;
      const candidates = yield* projections.getExpiredApprovalCandidates(now);
      for (const candidate of candidates)
        yield* expire(candidate.threadId, candidate.requestId).pipe(
          Effect.catchCause(() =>
            Effect.logWarning("orchestration-v2.approval-expiry.failed", {
              threadId: candidate.threadId,
              requestId: candidate.requestId,
            }),
          ),
        );
    }).pipe(Effect.mapError((cause) => new ApprovalExpiryError({ cause }))),
  });
});

export const layer = Layer.effect(ApprovalExpiry, make);
export const layerWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const expiry = yield* ApprovalExpiry;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("approval-expiry", expiry.sweep);
  }),
);
