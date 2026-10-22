// @effect-diagnostics nodeBuiltinImport:off - hooks need literal argv and a cancellable stdin pipe.
import * as NodeChildProcess from "node:child_process";

import type { ProjectFilesCopiedInput } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

const EventPayload = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.Literals(["clone.started", "clone.completed", "clone.failed", "files.copied"]),
    timestamp: Schema.String,
    source: Schema.Struct({ label: Schema.String }),
    target: Schema.Struct({ label: Schema.String }),
    repo: Schema.Struct({
      projectName: Schema.String,
      remoteUrl: Schema.optional(Schema.String),
    }),
    destinationPath: Schema.String,
    files: Schema.Array(Schema.String),
  }),
);
const encodeEventPayload = Schema.encodeEffect(EventPayload);

class HookCommandError extends Schema.TaggedError<HookCommandError>()("HookCommandError", {
  cause: Schema.Defect(),
}) {}

const HookConfig = Schema.Struct({
  timeoutMs: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60_000 }))),
  webhook: Schema.optional(
    Schema.Struct({
      url: Schema.String,
      header: Schema.optional(Schema.Struct({ name: Schema.String, env: Schema.String })),
    }),
  ),
  command: Schema.optional(
    Schema.Struct({
      executable: Schema.String,
      args: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
});

type EventInput = ProjectFilesCopiedInput & {
  readonly type: (typeof EventPayload.Type)["type"];
};

export class ProjectEventSink extends Context.Service<
  ProjectEventSink,
  {
    readonly emit: (input: EventInput) => Effect.Effect<void>;
    readonly filesCopied: (input: ProjectFilesCopiedInput) => Effect.Effect<void>;
  }
>()("t3/project/ProjectEventSink") {}

/** Unknown URL forms are omitted rather than risking credentials in an event. */
function safeRemoteUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // URL normalization can move apparent credentials out of a malformed authority.
  if (/[\\\u0000-\u0020\u007f]/.test(value.trim())) return undefined;
  try {
    const url = new URL(value);
    // Opaque and repaired URLs can put userinfo in the path, beyond credential stripping.
    if (
      !["http:", "https:", "ssh:", "git:"].includes(url.protocol) ||
      !url.hostname ||
      !/^[a-z][a-z0-9+.-]*:\/\/[^/\\]/i.test(value.trim())
    ) {
      return undefined;
    }
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    // A broken scheme URL can still contain credentials; it is never an SCP locator.
    if (/^[a-z][a-z0-9+.-]*:[/\\]/i.test(value.trim())) return undefined;
    const scp = /^(?:[^@/\s]+@)?([a-zA-Z0-9.-]+):([^?#\s]+)(?:[?#].*)?$/.exec(value);
    return scp ? `ssh://${scp[1]}/${scp[2]}` : undefined;
  }
}

function relativeFileNames(files: readonly string[]): string[] {
  return [...new Set(files.map((file) => file.replaceAll("\\", "/")))].filter(
    (file) =>
      file.length > 0 &&
      !file.startsWith("/") &&
      !file.includes(":") &&
      !/[\r\n\0]/.test(file) &&
      !file.split("/").some((part) => part === ".." || part === "."),
  );
}

const runCommand = Effect.fn("ProjectEventSink.runCommand")(function* (
  command: NonNullable<typeof HookConfig.Type.command>,
  json: string,
) {
  yield* Effect.callback<void, HookCommandError>((resume) => {
    const child = NodeChildProcess.spawn(command.executable, [...(command.args ?? [])], {
      shell: false,
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", (cause) => resume(Effect.fail(new HookCommandError({ cause }))));
    child.stdin.on("error", (cause) => resume(Effect.fail(new HookCommandError({ cause }))));
    child.on("close", () => resume(Effect.void));
    child.stdin.end(`${json}\n`);
    // Cancellation must also stop a hook that ignores termination requests.
    return Effect.sync(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
  });
});

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const env = yield* HostProcess.Environment;
  const scope = yield* Scope.Scope;
  const http = HttpClient.withScope(yield* HttpClient.HttpClient);
  const configPath = env.T3CODE_EVENT_HOOKS_CONFIG;
  const config = configPath
    ? yield* fs.readFileString(configPath).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(HookConfig))),
        Effect.orElseSucceed(() => undefined),
      )
    : undefined;
  let active = 0;

  const emit = Effect.fn("ProjectEventSink.emit")(function* (input: EventInput) {
    if (!config?.webhook && !config?.command) return;
    if (active >= 32) {
      yield* Effect.logDebug("Project event delivery limit reached", {
        activeEvents: active,
        droppedEvents: 1,
      });
      return;
    }
    // Explicit projection: callers may hold file contents or raw failure messages.
    const json = yield* encodeEventPayload({
      type: input.type,
      timestamp: DateTime.formatIso(yield* DateTime.now),
      source: { label: input.context.sourceLabel },
      target: { label: input.context.targetLabel },
      repo: { projectName: input.projectName, remoteUrl: safeRemoteUrl(input.remoteUrl) },
      destinationPath: input.destinationPath,
      files: relativeFileNames(input.files),
    });
    const timeout = config.timeoutMs ?? 3_000;
    const webhook = config.webhook;
    const deliverWebhook = webhook
      ? Effect.gen(function* () {
          const url = new URL(webhook.url);
          if (!["http:", "https:"].includes(url.protocol)) return;
          const headers: Record<string, string> = {};
          if (webhook.header) {
            if (!Object.hasOwn(env, webhook.header.env)) return;
            const value = env[webhook.header.env];
            if (!value) return;
            headers[webhook.header.name] = value;
          }
          yield* http.execute(
            HttpClientRequest.post(url.toString()).pipe(
              HttpClientRequest.bodyText(json, "application/json"),
              HttpClientRequest.setHeaders(headers),
            ),
          );
        }).pipe(
          // Hook URLs and headers can contain secrets, including on failed requests.
          Effect.withTracerEnabled(false),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
          Effect.scoped,
          Effect.timeout(timeout),
          Effect.ignoreCause(),
        )
      : Effect.void;
    const deliverCommand = config.command
      ? runCommand(config.command, json).pipe(
          // Spawn failures can include the executable path and argument values.
          Effect.withTracerEnabled(false),
          Effect.timeout(timeout),
          Effect.ignoreCause(),
        )
      : Effect.void;
    active++;
    yield* Effect.all([deliverWebhook, deliverCommand], { concurrency: "unbounded" }).pipe(
      Effect.ensuring(Effect.sync(() => active--)),
      Effect.forkIn(scope),
    );
  }, Effect.ignoreCause());

  return ProjectEventSink.of({
    emit,
    filesCopied: (input) => emit({ ...input, type: "files.copied" }),
  });
});

export const layer = Layer.effect(ProjectEventSink, make).pipe(
  Layer.provide(FetchHttpClient.layer),
);
