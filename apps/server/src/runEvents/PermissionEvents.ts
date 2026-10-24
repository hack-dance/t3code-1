import { approvalRequestExpiresAt, type OrchestrationV2StoredEvent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { approvalActionDigest } from "../orchestration-v2/ApprovalAction.ts";
import { forkParked } from "../serverActivation.ts";
import { loadConfig, type RunEventsConfig } from "./config.ts";
import * as Delivery from "./Delivery.ts";

const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export function permissionPayload(input: {
  stored: OrchestrationV2StoredEvent;
  config: NonNullable<RunEventsConfig["permissions"]>;
  projectId: string;
}) {
  const { event } = input.stored;
  if (event.type !== "runtime-request.updated") return undefined;
  const request = event.payload;
  const expiresAt = approvalRequestExpiresAt(request);
  if (expiresAt === null) return undefined;
  const status = request.status;
  const origin = new URL(input.config.t3Origin);
  if (
    origin.protocol !== "https:" ||
    !origin.hostname.endsWith(".ts.net") ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("Invalid T3 origin");
  return {
    version: 1,
    type: status === "pending" ? "work.needs_attention" : "work.attention_closed",
    eventId: `t3-permission:${input.config.environmentId}:${request.id}:${status}`,
    environmentId: input.config.environmentId,
    sourceHost: input.config.sourceHost,
    threadId: event.threadId,
    sessionId:
      request.responseCapability.type === "live"
        ? request.responseCapability.providerSessionId
        : (request.providerTurnId ?? request.id),
    requestId: request.id,
    t3Link: `${origin.origin}/${encodeURIComponent(input.projectId)}/${encodeURIComponent(event.threadId)}`,
    actionDigest: approvalActionDigest(request),
    requestKind: request.kind,
    createdAt: DateTime.toEpochMillis(request.createdAt),
    expiresAt,
    status,
    decision: request.decision ?? null,
  };
}

/** The committed event log is the outbox. A failed delivery never advances its cursor. */
export const layerWithConfig = (config: NonNullable<RunEventsConfig["permissions"]> | undefined) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      if (config === undefined) return;
      const sink = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const delivery = yield* Delivery.Delivery;
      const fs = yield* FileSystem.FileSystem;
      const server = yield* ServerConfig.ServerConfig;
      const cursorPath = `${server.stateDir}/permission-events.cursor`;
      const raw = yield* fs.readFileString(cursorPath).pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound" ? Effect.succeed("0") : Effect.fail(error),
        }),
      );
      const cursor = Number(raw);
      if (!Number.isSafeInteger(cursor) || cursor < 0)
        return yield* Effect.die(new Error("Invalid permission event cursor"));
      const deliver = Effect.fn("PermissionEvents.deliver")(function* (
        stored: OrchestrationV2StoredEvent,
      ) {
        const { event } = stored;
        if (
          event.type === "runtime-request.updated" &&
          approvalRequestExpiresAt(event.payload) !== null
        ) {
          const thread = yield* projections.getThread(event.threadId);
          const payload = permissionPayload({ stored, config, projectId: thread.projectId });
          const current = yield* projections.getRuntimeRequest(event.threadId, event.payload.id);
          const now = yield* DateTime.now;
          // Replay closes, but never wake the owner for a prompt that is already gone.
          if (
            payload &&
            (payload.status !== "pending" ||
              (current?.status === "pending" && payload.expiresAt > DateTime.toEpochMillis(now)))
          ) {
            yield* delivery
              .command(config, yield* encodePayload(payload))
              .pipe(Effect.timeout(config.timeoutMs ?? 30_000));
          }
        }
        yield* fs.writeFileString(`${cursorPath}.tmp`, String(stored.sequence), { mode: 0o600 });
        yield* fs.rename(`${cursorPath}.tmp`, cursorPath);
      });
      yield* forkParked(
        Stream.runForEach(sink.stream({ afterSequence: cursor }), (stored) =>
          deliver(stored).pipe(
            Effect.tapError(() =>
              Effect.logWarning(
                "Permission event delivery failed; retrying with the same identity.",
              ),
            ),
            Effect.retry({ schedule: Schedule.spaced("5 seconds") }),
          ),
        ).pipe(
          Effect.catchCause(() =>
            Effect.logWarning("Permission event delivery stopped; cursor retained."),
          ),
        ),
      );
    }),
  );

export const layer = Layer.unwrap(
  loadConfig().pipe(Effect.map((config) => layerWithConfig(config?.permissions))),
).pipe(Layer.provide(Delivery.layer));
