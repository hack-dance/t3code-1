import { expect, it } from "@effect/vitest";
import { afterEach, describe, vi } from "vite-plus/test";
import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { RunEventsConfig } from "./config.ts";
import * as Delivery from "./Delivery.ts";
import { RunEvent, createPayload, lifecycleStatus, workspaceLabel } from "./payload.ts";
import * as RunEvents from "./RunEvents.ts";

const decodePayload = Schema.decodeUnknownSync(Schema.fromJsonString(RunEvent));

const selection = { providerInstanceIds: ["provider-a"], projectIds: ["project-a"] };

const at = DateTime.makeUnsafe("2026-01-01T00:00:00Z");
const later = DateTime.makeUnsafe("2026-01-01T00:00:02Z");
const run: OrchestrationV2Run = {
  id: RunId.make("run-a"),
  threadId: ThreadId.make("thread-a"),
  ordinal: 1,
  providerInstanceId: ProviderInstanceId.make("provider-a"),
  modelSelection: { instanceId: ProviderInstanceId.make("provider-a"), model: "model-a" },
  providerThreadId: null,
  userMessageId: MessageId.make("message-a"),
  rootNodeId: null,
  activeAttemptId: null,
  status: "starting",
  requestedAt: at,
  startedAt: null,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
};
const decodeEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEvent);

function event(
  status: OrchestrationV2Run["status"],
  id = run.id,
  occurredAt = later,
): OrchestrationV2DomainEvent {
  return decodeEvent({
    type: status === "starting" ? "run.created" : "run.updated",
    id: `event-${status}`,
    threadId: run.threadId,
    occurredAt,
    payload: {
      ...run,
      id,
      status,
      startedAt: status === "starting" ? null : at,
      completedAt: ["completed", "failed", "interrupted", "cancelled"].includes(status)
        ? occurredAt
        : null,
    },
  });
}

const dependencies = Layer.mergeAll(
  Path.layer,
  Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.never }),
  Layer.mock(ProjectionStore.ProjectionStoreV2)({
    getThread: () =>
      Effect.succeed({
        projectId: ProjectId.make("project-a"),
        worktreePath: null,
        title: "PRIVATE MESSAGE SENTINEL",
      } as never),
  }),
  Layer.mock(ProjectStore.ProjectStoreV2)({
    get: () =>
      Effect.succeed(
        Option.some({
          title: "Example project",
          workspaceRoot: "/workspace/project",
        } as never),
      ),
  }),
  Layer.mock(ProviderRegistry.ProviderRegistry)({
    getProviders: Effect.succeed([
      { instanceId: run.providerInstanceId, driver: "codex" } as never,
    ]),
  }),
);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("run events", () => {
  it.effect("is a no-op without a configured sink", () =>
    Effect.gen(function* () {
      const service = yield* RunEvents.RunEvents;
      yield* service.onEvent(event("starting"));
    }).pipe(
      Effect.provide(
        RunEvents.layerWithConfig(undefined).pipe(
          Layer.provide(Layer.mergeAll(dependencies, Layer.mock(Delivery.Delivery)({}))),
        ),
      ),
      Effect.scoped,
    ),
  );

  it("validates bounded settings and environment variable names", () => {
    const decode = Schema.decodeUnknownSync(RunEventsConfig);
    expect(decode({})).toEqual({});
    for (const webhook of [
      { url: "file:///workspace/hook" },
      { url: "https://example.com", retries: 6 },
      { url: "https://example.com", timeoutMs: 0 },
      { url: "https://example.com", hmacSecretEnv: "not a name" },
    ])
      expect(() => decode({ webhook })).toThrow();
  });

  it.effect("allowlists payload fields, has stable IDs, and never uses the hostname", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const input = {
        run: { ...run, prompt: "PRIVATE PROMPT SENTINEL", message: "PRIVATE MESSAGE SENTINEL" },
        status: "started" as const,
        occurredAt: at,
        provider: "codex",
        projectName: "Example project",
        workspaceLabel: ".",
        hostLabel: "",
      };
      const payload = createPayload(input);
      expect(payload.eventId).toBe(createPayload({ ...input, occurredAt: later }).eventId);
      expect(payload.hostLabel).toBe("");
      expect(JSON.stringify(payload)).not.toContain("SENTINEL");
      expect(Object.keys(payload).sort()).toEqual(
        [
          "type",
          "eventId",
          "timestamp",
          "threadId",
          "turnOrdinal",
          "provider",
          "model",
          "projectName",
          "workspaceLabel",
          "hostLabel",
          "status",
          "durationMs",
        ].sort(),
      );
      expect(
        createPayload({
          ...input,
          run: { ...run, startedAt: at, completedAt: later },
          status: "completed",
        }).durationMs,
      ).toBe(2000);
      expect(workspaceLabel(path, "/workspace/project", "/workspace/project/subdir")).toBe(
        "subdir",
      );
      expect(workspaceLabel(path, "/workspace/project", "/other/worktree")).toBe("[worktree]");
      expect(workspaceLabel(path, "/workspace/project", null)).toBe(".");
      for (const status of ["preparing", "queued", "rolled_back"] as const)
        expect(lifecycleStatus({ ...run, status })).toBeUndefined();
    }).pipe(Effect.provide(Path.layer)),
  );

  it.effect("emits one start and terminal event across repeated updates for all outcomes", () =>
    Effect.gen(function* () {
      const done = yield* Deferred.make<void>();
      const bodies: Array<Record<string, unknown>> = [];
      const delivery = Layer.succeed(Delivery.Delivery, {
        webhook: (_, body) =>
          Effect.gen(function* () {
            bodies.push(JSON.parse(body));
            if (bodies.length === 8) yield* Deferred.succeed(done, undefined);
          }),
        command: () => Effect.void,
      });
      yield* Effect.gen(function* () {
        const service = yield* RunEvents.RunEvents;
        for (const status of ["completed", "failed", "interrupted", "cancelled"] as const) {
          const id = RunId.make(`run-${status}`);
          yield* service.onEvent(event("queued", id));
          yield* service.onEvent(event("starting", id));
          yield* service.onEvent(event("running", id));
          yield* service.onEvent(event(status, id));
          yield* service.onEvent(event(status, id));
        }
        yield* Deferred.await(done);
        expect(bodies.map((body) => body.status)).toEqual([
          "started",
          "completed",
          "started",
          "failed",
          "started",
          "interrupted",
          "started",
          "cancelled",
        ]);
        expect(bodies.map((body) => body.type)).toEqual([
          "run.started",
          "run.completed",
          "run.started",
          "run.failed",
          "run.started",
          "run.failed",
          "run.started",
          "run.failed",
        ]);
        expect(bodies.every((body) => body.hostLabel === "")).toBe(true);
        expect(JSON.stringify(bodies)).not.toContain("SENTINEL");
      }).pipe(
        Effect.provide(
          RunEvents.layerWithConfig({ webhook: { ...selection, url: "https://example.com" } }).pipe(
            Layer.provide(dependencies),
            Layer.provide(delivery),
          ),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "slow and failing sinks do not block lifecycle handling or the other sink; timeouts retry with backoff",
    () =>
      Effect.gen(function* () {
        const firstAttempt = yield* Deferred.make<void>();
        const retry = yield* Deferred.make<void>();
        const commandDone = yield* Deferred.make<void>();
        let calls = 0;
        let commandCalls = 0;
        const delivery = Layer.succeed(Delivery.Delivery, {
          webhook: () =>
            Effect.gen(function* () {
              calls++;
              if (calls === 1) {
                yield* Deferred.succeed(firstAttempt, undefined);
                return yield* Effect.never;
              }
              yield* Deferred.succeed(retry, undefined);
              return yield* new Delivery.DeliveryError({ retryable: true });
            }),
          command: () =>
            Effect.gen(function* () {
              if (++commandCalls === 2) yield* Deferred.succeed(commandDone, undefined);
            }),
        });
        yield* Effect.gen(function* () {
          const service = yield* RunEvents.RunEvents;
          yield* service.onEvent(event("starting"));
          yield* Deferred.await(firstAttempt);
          yield* service.onEvent(event("completed"));
          yield* Deferred.await(commandDone);
          expect(calls).toBe(1);
          yield* TestClock.adjust(100);
          expect(calls).toBe(1);
          yield* TestClock.adjust(10);
          yield* Deferred.await(retry);
          expect(calls).toBeGreaterThanOrEqual(2);
        }).pipe(
          Effect.provide(
            RunEvents.layerWithConfig({
              webhook: {
                ...selection,
                url: "https://example.com",
                timeoutMs: 100,
                retries: 1,
                backoffMs: 10,
              },
              command: { ...selection, executable: "hook" },
            }).pipe(Layer.provide(dependencies), Layer.provide(delivery)),
          ),
        );
      }).pipe(Effect.scoped),
  );
});

it.effect(
  "observes the shared live stream without requiring callers to publish notifications",
  () =>
    Effect.gen(function* () {
      const done = yield* Deferred.make<void>();
      const statuses: unknown[] = [];
      const delivery = Layer.succeed(Delivery.Delivery, {
        webhook: () => Effect.void,
        command: (_, body) =>
          Effect.gen(function* () {
            statuses.push(JSON.parse(body).status);
            if (statuses.length === 2) yield* Deferred.succeed(done, undefined);
          }),
      });
      yield* Effect.gen(function* () {
        yield* RunEvents.RunEvents;
        yield* Deferred.await(done);
        expect(statuses).toEqual(["started", "completed"]);
      }).pipe(
        Effect.provide(
          RunEvents.layerWithConfig({ command: { ...selection, executable: "hook" } }).pipe(
            Layer.provide(
              Layer.mock(Orchestrator.OrchestratorV2)({
                streamDomainEvents: Stream.fromIterable([event("starting"), event("completed")]),
              }),
            ),
            Layer.provide(dependencies),
            Layer.provide(delivery),
          ),
        ),
      );
    }).pipe(Effect.scoped),
);

it.effect("reports new terminal revisions after preparation retries, preserving retry IDs", () =>
  Effect.gen(function* () {
    const done = yield* Deferred.make<void>();
    const delivered: RunEvent[] = [];
    const attempts: string[] = [];
    const failedDeliveries = new Set<string>();
    const delivery = Layer.succeed(Delivery.Delivery, {
      command: () => Effect.void,
      webhook: (_, body) =>
        Effect.gen(function* () {
          const payload = decodePayload(body);
          attempts.push(payload.eventId);
          if (!failedDeliveries.has(payload.eventId)) {
            failedDeliveries.add(payload.eventId);
            return yield* new Delivery.DeliveryError({ retryable: true });
          }
          delivered.push(payload);
          if (delivered.length === 4) yield* Deferred.succeed(done, undefined);
        }),
    });
    yield* Effect.gen(function* () {
      const service = yield* RunEvents.RunEvents;
      const secondFailure = DateTime.makeUnsafe("2026-01-01T00:00:03Z");
      const completed = DateTime.makeUnsafe("2026-01-01T00:00:04Z");
      for (const update of [
        event("preparing"),
        event("failed"),
        event("failed"),
        event("preparing"),
        event("failed", run.id, secondFailure),
        event("failed", run.id, secondFailure),
        event("preparing"),
        event("starting"),
        event("completed", run.id, completed),
        event("completed", run.id, completed),
      ]) {
        yield* service.onEvent(update);
      }
      yield* TestClock.adjust(1000);
      yield* Deferred.await(done);
      expect(delivered.map(({ status }) => status)).toEqual([
        "failed",
        "failed",
        "started",
        "completed",
      ]);
      expect(new Set(delivered.map(({ eventId }) => eventId)).size).toBe(4);
      expect(attempts).toEqual(delivered.flatMap(({ eventId }) => [eventId, eventId]));
    }).pipe(
      Effect.provide(
        RunEvents.layerWithConfig({
          webhook: { ...selection, url: "https://example.com", backoffMs: 1 },
        }).pipe(Layer.provide(dependencies), Layer.provide(delivery)),
      ),
    );
  }).pipe(Effect.scoped),
);

it.effect("permanent delivery errors release the queue without retry delay", () =>
  Effect.gen(function* () {
    const done = yield* Deferred.make<void>();
    const statuses: string[] = [];
    const delivery = Layer.succeed(Delivery.Delivery, {
      command: () => Effect.void,
      webhook: (_, body) =>
        Effect.gen(function* () {
          const { status } = decodePayload(body);
          statuses.push(status);
          if (status === "started") return yield* new Delivery.DeliveryError({ retryable: false });
          yield* Deferred.succeed(done, undefined);
        }),
    });
    yield* Effect.gen(function* () {
      const service = yield* RunEvents.RunEvents;
      yield* service.onEvent(event("starting"));
      yield* service.onEvent(event("completed"));
      yield* Deferred.await(done);
      expect(statuses).toEqual(["started", "completed"]);
    }).pipe(
      Effect.provide(
        RunEvents.layerWithConfig({
          webhook: { ...selection, url: "https://example.com", retries: 5 },
        }).pipe(Layer.provide(dependencies), Layer.provide(delivery)),
      ),
    );
  }).pipe(Effect.scoped),
);

it.effect("does not repeat failed metadata lookups for the same lifecycle notification", () =>
  Effect.gen(function* () {
    for (const failedLookup of ["thread", "project"] as const) {
      const threadRead = vi.fn(() =>
        failedLookup === "thread"
          ? Effect.die("lookup failure")
          : Effect.succeed({ projectId: ProjectId.make("project-a"), worktreePath: null } as never),
      );
      const projectRead = vi.fn(() => Effect.die("lookup failure"));
      yield* Effect.gen(function* () {
        const service = yield* RunEvents.RunEvents;
        for (const status of ["starting", "running", "waiting", "waiting"] as const)
          yield* service.onEvent(event(status));
        expect(threadRead).toHaveBeenCalledTimes(1);
        expect(projectRead).toHaveBeenCalledTimes(failedLookup === "project" ? 1 : 0);
      }).pipe(
        Effect.provide(
          RunEvents.layerWithConfig({ webhook: { ...selection, url: "https://example.com" } }).pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(ProjectionStore.ProjectionStoreV2)({ getThread: threadRead }),
                Layer.mock(ProjectStore.ProjectStoreV2)({ get: projectRead }),
                Layer.mock(Delivery.Delivery)({}),
              ),
            ),
            Layer.provide(dependencies),
          ),
        ),
      );
    }
  }).pipe(Effect.scoped),
);

it.effect("isolates sinks by both project and provider instance, even for the same engine", () =>
  Effect.gen(function* () {
    const webhookDone = yield* Deferred.make<void>();
    const commandDone = yield* Deferred.make<void>();
    const webhookEvents: RunEvent[] = [];
    const commandEvents: RunEvent[] = [];
    const delivery = Layer.succeed(Delivery.Delivery, {
      webhook: (_, body) =>
        Effect.sync(() => webhookEvents.push(decodePayload(body))).pipe(
          Effect.andThen(Deferred.succeed(webhookDone, undefined)),
          Effect.asVoid,
        ),
      command: (_, body) =>
        Effect.sync(() => commandEvents.push(decodePayload(body))).pipe(
          Effect.andThen(Deferred.succeed(commandDone, undefined)),
          Effect.asVoid,
        ),
    });
    const isolated = Layer.mergeAll(
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThread: (threadId) =>
          Effect.succeed({
            projectId: ProjectId.make(threadId === "thread-a" ? "project-a" : "project-b"),
            worktreePath: null,
          } as never),
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed(
          ["provider-a", "provider-b"].map(
            (instanceId) =>
              ({ instanceId: ProviderInstanceId.make(instanceId), driver: "codex" }) as never,
          ),
        ),
      }),
    );
    yield* Effect.gen(function* () {
      const service = yield* RunEvents.RunEvents;
      for (const [threadId, providerInstanceId, id] of [
        ["thread-a", "provider-b", "cross-a"],
        ["thread-b", "provider-a", "cross-b"],
        ["thread-a", "provider-a", "allowed-a"],
        ["thread-b", "provider-b", "allowed-b"],
      ] as const) {
        yield* service.onEvent(
          decodeEvent({
            type: "run.created",
            id: `event-${id}`,
            threadId,
            occurredAt: at,
            payload: {
              ...run,
              id,
              threadId,
              providerInstanceId,
              modelSelection: { instanceId: providerInstanceId, model: "model-a" },
            },
          }),
        );
      }
      yield* Deferred.await(webhookDone);
      yield* Deferred.await(commandDone);
      expect(webhookEvents.map(({ threadId }) => threadId)).toEqual(["thread-a"]);
      expect(commandEvents.map(({ threadId }) => threadId)).toEqual(["thread-b"]);
      expect([...webhookEvents, ...commandEvents].map(({ provider }) => provider)).toEqual([
        "codex",
        "codex",
      ]);
    }).pipe(
      Effect.provide(
        RunEvents.layerWithConfig({
          webhook: { ...selection, url: "https://example.com" },
          command: {
            executable: "hook",
            providerInstanceIds: ["provider-b"],
            projectIds: ["project-b"],
          },
        }).pipe(Layer.provide(isolated), Layer.provide(dependencies), Layer.provide(delivery)),
      ),
    );
  }).pipe(Effect.scoped),
);

it.effect("missing and empty sink allowlists deliver nothing and avoid metadata reads", () =>
  Effect.gen(function* () {
    const read = vi.fn(() => Effect.die("unexpected metadata lookup"));
    for (const filters of [
      {},
      { providerInstanceIds: ["provider-a"] },
      { projectIds: ["project-a"] },
      { providerInstanceIds: [], projectIds: ["project-a"] },
      { providerInstanceIds: ["provider-a"], projectIds: [] },
    ]) {
      yield* Effect.gen(function* () {
        const service = yield* RunEvents.RunEvents;
        yield* service.onEvent(event("starting"));
        yield* service.onEvent(event("completed"));
      }).pipe(
        Effect.provide(
          RunEvents.layerWithConfig({
            webhook: { ...filters, url: "https://example.com" },
            command: { ...filters, executable: "hook" },
          }).pipe(
            Layer.provide(Layer.mock(ProjectionStore.ProjectionStoreV2)({ getThread: read })),
            Layer.provide(dependencies),
            Layer.provide(Layer.mock(Delivery.Delivery)({})),
          ),
        ),
      );
    }
    expect(read).not.toHaveBeenCalled();
  }).pipe(Effect.scoped),
);

it.effect(
  "keeps an active run's start marker while newer runs pass through the bounded cache",
  () =>
    Effect.gen(function* () {
      const done = yield* Deferred.make<void>();
      const statuses: string[] = [];
      const delivery = Layer.succeed(Delivery.Delivery, {
        command: () => Effect.void,
        webhook: (_, body) =>
          Effect.gen(function* () {
            const { status } = decodePayload(body);
            statuses.push(status);
            if (status === "completed") yield* Deferred.succeed(done, undefined);
          }),
      });
      yield* Effect.gen(function* () {
        const service = yield* RunEvents.RunEvents;
        yield* service.onEvent(event("starting"));
        for (let index = 0; index < 4100; index++) {
          yield* service.onEvent(
            decodeEvent({
              type: "run.created",
              id: `event-${index}`,
              threadId: run.threadId,
              occurredAt: at,
              payload: { ...run, id: `excluded-${index}`, providerInstanceId: "provider-b" },
            }),
          );
          if (index % 1000 === 0) yield* service.onEvent(event("waiting"));
        }
        yield* service.onEvent(event("waiting"));
        yield* service.onEvent(event("completed"));
        yield* Deferred.await(done);
        expect(statuses).toEqual(["started", "completed"]);
      }).pipe(
        Effect.provide(
          RunEvents.layerWithConfig({ webhook: { ...selection, url: "https://example.com" } }).pipe(
            Layer.provide(dependencies),
            Layer.provide(delivery),
          ),
        ),
      );
    }).pipe(Effect.scoped),
);
