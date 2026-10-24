import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { OrchestrationV2StoredEvent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Delivery from "./Delivery.ts";
import { layerWithConfig, permissionPayload } from "./PermissionEvents.ts";

const config = {
  environmentId: "env",
  sourceHost: "host",
  t3Origin: "https://host.example.ts.net",
  executable: "fixture-hook",
};
const decodeBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ type: Schema.String })),
);
const decode = Schema.decodeUnknownSync(OrchestrationV2StoredEvent);
const at = DateTime.makeUnsafe("2026-01-01T00:00:00Z");
function stored(status = "pending", sequence = 1) {
  return decode({
    sequence,
    commandId: null,
    event: {
      id: `event-${status}`,
      type: "runtime-request.updated",
      threadId: "thread",
      occurredAt: at,
      payload: {
        id: "request",
        nodeId: "node",
        providerTurnId: null,
        nativeRequestRef: null,
        providerSessionId: "session",
        kind: "command",
        status,
        responseCapability: { type: "live", providerSessionId: "session" },
        createdAt: at,
        resolvedAt: status === "pending" ? null : at,
        action: { command: "sensitive action retained only in T3", cwd: "/project" },
      },
    },
  });
}

it("correlates open and close events to the same exact action without publishing its contents", () => {
  const opened = permissionPayload({ stored: stored(), config, projectId: "project" });
  const closed = permissionPayload({ stored: stored("expired", 2), config, projectId: "project" });
  expect(opened?.type).toBe("work.needs_attention");
  expect(closed?.type).toBe("work.attention_closed");
  expect(opened?.actionDigest).toBe(closed?.actionDigest);
  expect(opened?.expiresAt).toBe(DateTime.toEpochMillis(at) + 14_400_000);
  expect(opened?.t3Link).toBe("https://host.example.ts.net/project/thread");
  expect(JSON.stringify(opened)).not.toContain("sensitive action");
});

it("preserves native session identity and action digest when a callback becomes non-resumable", () => {
  const opened = stored();
  const closed = stored("cancelled", 2);
  if (closed.event.type !== "runtime-request.updated") return;
  const unavailable = {
    ...closed,
    event: {
      ...closed.event,
      payload: {
        ...closed.event.payload,
        responseCapability: { type: "not_resumable" as const, reason: "Provider stopped" },
      },
    },
  };
  const first = permissionPayload({ stored: opened, config, projectId: "project" });
  const last = permissionPayload({ stored: unavailable, config, projectId: "project" });
  expect(last?.sessionId).toBe(first?.sessionId);
  expect(last?.actionDigest).toBe(first?.actionDigest);
});

it.effect.each([false, true])(
  "durably delivers ordinary-session prompts and closes in order (retry=%s)",
  (retry) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(at));
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const done = yield* Deferred.make<void>();
      const failed = yield* Deferred.make<void>();
      let attempts = 0;
      const bodies: string[] = [];
      const fixtures = [stored(), stored("resolved", 2)];
      const pending = fixtures[0]!.event;
      if (pending.type !== "runtime-request.updated") return;
      const dependencies = Layer.mergeAll(
        Layer.succeed(ServerConfig.ServerConfig, {
          stateDir: directory,
        } as ServerConfig.ServerConfig["Service"]),
        Layer.mock(EventSink.EventSinkV2)({
          stream: (options) => {
            expect(options?.afterSequence).toBe(0);
            return Stream.fromIterable(fixtures);
          },
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThread: () => Effect.succeed({ projectId: "project" } as never),
          getRuntimeRequest: () => Effect.succeed(pending.payload),
        }),
        Layer.succeed(Delivery.Delivery, {
          webhook: () => Effect.void,
          command: (_, body) =>
            Effect.gen(function* () {
              attempts += 1;
              if (retry && attempts === 1) {
                yield* Deferred.succeed(failed, undefined);
                return yield* new Delivery.DeliveryError({ retryable: true });
              }
              bodies.push(body);
            }),
        }),
        Layer.succeed(FileSystem.FileSystem, {
          ...fs,
          rename: (from, to) =>
            fs
              .rename(from, to)
              .pipe(
                Effect.tap(() =>
                  from.endsWith(".tmp") && bodies.length === 2
                    ? Deferred.succeed(done, undefined)
                    : Effect.void,
                ),
              ),
        }),
      );
      yield* Effect.gen(function* () {
        if (retry) {
          yield* Deferred.await(failed);
          expect(yield* fs.exists(`${directory}/permission-events.cursor`)).toBe(false);
          yield* TestClock.adjust("5 seconds");
        }
        yield* Deferred.await(done);
        expect(attempts).toBe(retry ? 3 : 2);
        expect(bodies.map((body) => decodeBody(body).type)).toEqual([
          "work.needs_attention",
          "work.attention_closed",
        ]);
        expect(yield* fs.readFileString(`${directory}/permission-events.cursor`)).toBe("2");
      }).pipe(Effect.provide(layerWithConfig(config).pipe(Layer.provide(dependencies))));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
