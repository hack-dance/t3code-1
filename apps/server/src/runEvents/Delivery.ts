// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect Crypto does not provide HMAC.
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { RunEventsConfig } from "./config.ts";

export class DeliveryError extends Schema.TaggedError<DeliveryError>()(
  "RunEventDeliveryError",
  {},
) {}

export class Delivery extends Context.Service<
  Delivery,
  {
    readonly webhook: (
      config: NonNullable<RunEventsConfig["webhook"]>,
      body: string,
    ) => Effect.Effect<void, DeliveryError>;
    readonly command: (
      config: NonNullable<RunEventsConfig["command"]>,
      body: string,
    ) => Effect.Effect<void, DeliveryError>;
  }
>()("t3/runEvents/Delivery") {}

const make = Effect.gen(function* () {
  const http = HttpClient.withScope(yield* HttpClient.HttpClient);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const webhook = Effect.fn("RunEvents.webhook")(function* (
    config: NonNullable<RunEventsConfig["webhook"]>,
    body: string,
  ) {
    const headers: Record<string, string> = {};
    if (config.authHeaderEnv) {
      const value = process.env[config.authHeaderEnv];
      if (!value) return yield* new DeliveryError();
      headers.Authorization = value;
    }
    if (config.hmacSecretEnv) {
      const value = process.env[config.hmacSecretEnv];
      if (!value) return yield* new DeliveryError();
      headers["X-T3-Signature-256"] =
        `sha256=${NodeCrypto.createHmac("sha256", value).update(body).digest("hex")}`;
    }
    yield* HttpClientRequest.post(config.url).pipe(
      HttpClientRequest.setHeaders(headers),
      HttpClientRequest.bodyText(body, "application/json"),
      http.execute,
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      Effect.mapError(() => new DeliveryError()),
    );
  }, Effect.scoped);
  const command = Effect.fn("RunEvents.command")(function* (
    config: NonNullable<RunEventsConfig["command"]>,
    body: string,
  ) {
    const code = yield* spawner
      .exitCode(
        ChildProcess.make(config.executable, config.args ?? [], {
          shell: false,
          stdin: Stream.make(new TextEncoder().encode(`${body}\n`)),
          stdout: "ignore",
          stderr: "ignore",
          killSignal: "SIGKILL",
        }),
      )
      .pipe(Effect.mapError(() => new DeliveryError()));
    if (code !== 0) return yield* new DeliveryError();
  }, Effect.scoped);
  return Delivery.of({ webhook, command });
});

export const layer = Layer.effect(Delivery, make).pipe(Layer.provide(FetchHttpClient.layer));
