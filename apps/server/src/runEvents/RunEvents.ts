import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import { loadConfig, type RunEventsConfig } from "./config.ts";
import * as Delivery from "./Delivery.ts";
import { RunEvent, createPayload, lifecycleStatus, workspaceLabel } from "./payload.ts";

const encodePayload = Schema.encodeEffect(Schema.fromJsonString(RunEvent));

export class RunEvents extends Context.Service<
  RunEvents,
  {
    readonly onEvent: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/runEvents/RunEvents") {}

export const layerWithConfig = (config: RunEventsConfig | undefined) =>
  Layer.effect(
    RunEvents,
    Effect.gen(function* () {
      if (!config?.webhook && !config?.command) return RunEvents.of({ onEvent: () => Effect.void });
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const projects = yield* ProjectStore.ProjectStoreV2;
      const path = yield* Path.Path;
      const providers = yield* ProviderRegistry.ProviderRegistry;
      const delivery = yield* Delivery.Delivery;
      const queues: Array<Queue.Queue<string>> = [];

      const startSink = Effect.fn("RunEvents.startSink")(function* (
        options: {
          timeoutMs?: number | undefined;
          retries?: number | undefined;
          backoffMs?: number | undefined;
        },
        send: (body: string) => Effect.Effect<void, Delivery.DeliveryError>,
      ) {
        const queue = yield* Queue.dropping<string>(256);
        queues.push(queue);
        const deliver = Effect.fn("RunEvents.deliver")(function* (body: string) {
          for (let attempt = 0; attempt <= (options.retries ?? 2); attempt++) {
            const result = yield* send(body).pipe(
              Effect.timeout(options.timeoutMs ?? 5_000),
              Effect.exit,
            );
            if (result._tag === "Success") return;
            if (attempt < (options.retries ?? 2))
              yield* Effect.sleep(Math.min(30_000, (options.backoffMs ?? 250) * 2 ** attempt));
          }
          yield* Effect.logWarning("Run event delivery exhausted retries.");
        });
        yield* forkParked(Effect.forever(Queue.take(queue).pipe(Effect.flatMap(deliver))));
      });
      if (config.webhook) {
        const webhook = config.webhook;
        yield* startSink(webhook, (body) => delivery.webhook(webhook, body));
      }
      if (config.command) {
        const command = config.command;
        yield* startSink(command, (body) => delivery.command(command, body));
      }

      // Bound duplicate tracking; stable IDs let receivers deduplicate after eviction/restart.
      const reported = new Set<string>();
      // The stream sees every domain event. Avoid a tracing span for unrelated events.
      const onEvent = Effect.fnUntraced(
        function* (event: OrchestrationV2DomainEvent) {
          if (event.type !== "run.created" && event.type !== "run.updated") return;
          const status = lifecycleStatus(event.payload);
          if (!status) return;
          const key = `${event.threadId}:${event.payload.id}:${status === "started" ? "start" : "finish"}`;
          if (reported.has(key)) return;
          const thread = yield* projections.getThread(event.threadId);
          const project = yield* projects.get(thread.projectId, { includeDeleted: true });
          const catalog = yield* providers.getProviders;
          const payload = createPayload({
            run: event.payload,
            status,
            occurredAt: event.occurredAt,
            provider:
              catalog.find((provider) => provider.instanceId === event.payload.providerInstanceId)
                ?.driver ?? "unknown",
            projectName: Option.isSome(project) ? project.value.title : "",
            workspaceLabel: Option.isSome(project)
              ? workspaceLabel(path, project.value.workspaceRoot, thread.worktreePath)
              : "",
            hostLabel: config.hostLabel ?? "",
          });
          reported.add(key);
          if (reported.size > 4096) {
            const oldest = reported.values().next().value;
            if (oldest !== undefined) reported.delete(oldest);
          }
          const body = yield* encodePayload(payload);
          for (const queue of queues) {
            const accepted = yield* Queue.offer(queue, body);
            if (!accepted) yield* Effect.logWarning("Run event queue full; notification dropped.");
          }
        },
        (effect) =>
          effect.pipe(
            Effect.catchCause(() => Effect.logWarning("Run event notification skipped.")),
          ),
      );

      yield* forkParked(
        Stream.runForEach(orchestrator.streamDomainEvents, onEvent).pipe(
          Effect.catchCause(() => Effect.logWarning("Run event subscription stopped.")),
        ),
      );
      return RunEvents.of({ onEvent });
    }),
  );

export const layer = Layer.unwrap(loadConfig().pipe(Effect.map(layerWithConfig))).pipe(
  Layer.provide(Delivery.layer),
);
