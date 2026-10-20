import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

const EnvName = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/));
const Timeout = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60_000 }));
const RetryCount = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 }));
const Backoff = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000 }));

const SinkSelection = {
  providerInstanceIds: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  projectIds: Schema.optional(Schema.Array(Schema.NonEmptyString)),
};

export const RunEventsConfig = Schema.Struct({
  hostLabel: Schema.optional(Schema.String),
  webhook: Schema.optional(
    Schema.Struct({
      ...SinkSelection,
      url: Schema.String.check(
        Schema.makeFilter((value) => {
          try {
            const url = new URL(value);
            return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
          } catch {
            return false;
          }
        }),
      ),
      authHeaderEnv: Schema.optional(EnvName),
      hmacSecretEnv: Schema.optional(EnvName),
      timeoutMs: Schema.optional(Timeout),
      retries: Schema.optional(RetryCount),
      backoffMs: Schema.optional(Backoff),
    }),
  ),
  command: Schema.optional(
    Schema.Struct({
      ...SinkSelection,
      executable: Schema.NonEmptyString,
      args: Schema.optional(Schema.Array(Schema.String)),
      timeoutMs: Schema.optional(Timeout),
      retries: Schema.optional(RetryCount),
      backoffMs: Schema.optional(Backoff),
    }),
  ),
});
export type RunEventsConfig = typeof RunEventsConfig.Type;

const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(RunEventsConfig));

export const loadConfig = Effect.fn("RunEvents.loadConfig")(function* () {
  const path = process.env.T3CODE_RUN_EVENTS_CONFIG;
  if (!path) return undefined;
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(path).pipe(
    Effect.flatMap(decodeConfig),
    // Config errors can contain credentials or private paths. Never log the cause.
    Effect.catchCause(() =>
      Effect.logWarning("Run events disabled: invalid configuration.").pipe(Effect.as(undefined)),
    ),
  );
});
