import { expect, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Delivery from "./Delivery.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.effect("POSTs exact bytes with authorization and a known HMAC-SHA256 signature", () =>
  Effect.gen(function* () {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubEnv("RUN_EVENT_TEST_AUTH", "Bearer example-token");
    vi.stubEnv("RUN_EVENT_TEST_KEY", "key");
    const service = yield* Delivery.Delivery;
    yield* service
      .webhook(
        {
          url: "https://example.com/events",
          authHeaderEnv: "RUN_EVENT_TEST_AUTH",
          hmacSecretEnv: "RUN_EVENT_TEST_KEY",
        },
        "The quick brown fox jumps over the lazy dog",
      )
      .pipe(Effect.provideService(FetchHttpClient.Fetch, fetchMock));
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://example.com/events"),
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        body: Buffer.from("The quick brown fox jumps over the lazy dog", "utf8"),
        headers: expect.objectContaining({
          "content-type": "application/json",
          authorization: "Bearer example-token",
          "x-t3-signature-256":
            "sha256=f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
        }),
      }),
    );
  }).pipe(Effect.provide(Delivery.layer.pipe(Layer.provide(NodeServices.layer)))),
);

it.effect("does not send when a configured secret is missing and rejects HTTP failures", () =>
  Effect.gen(function* () {
    const fetchMock = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubEnv("RUN_EVENT_TEST_MISSING", undefined);
    const service = yield* Delivery.Delivery;
    const missing = yield* service
      .webhook({ url: "https://example.com", hmacSecretEnv: "RUN_EVENT_TEST_MISSING" }, "{}")
      .pipe(Effect.exit, Effect.provideService(FetchHttpClient.Fetch, fetchMock));
    expect(missing._tag).toBe("Failure");
    expect(fetchMock).not.toHaveBeenCalled();
    const rejected = yield* service
      .webhook({ url: "https://example.com" }, "{}")
      .pipe(Effect.exit, Effect.provideService(FetchHttpClient.Fetch, fetchMock));
    expect(rejected._tag).toBe("Failure");
  }).pipe(Effect.provide(Delivery.layer.pipe(Layer.provide(NodeServices.layer)))),
);

it.effect("passes JSON on stdin and literal arguments without a shell", () =>
  Effect.gen(function* () {
    const service = yield* Delivery.Delivery;
    yield* service.command(
      {
        executable: process.execPath,
        args: [
          "-e",
          `
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      process.exit(value.type === "run.started" && process.argv[1] === "$(exit 99); *" ? 0 : 1);
    });
  `,
          "$(exit 99); *",
        ],
      },
      '{"type":"run.started"}',
    );
    const failed = yield* service
      .command({ executable: process.execPath, args: ["-e", "process.exit(7)"] }, "{}")
      .pipe(Effect.exit);
    expect(failed._tag).toBe("Failure");
  }).pipe(Effect.provide(Delivery.layer.pipe(Layer.provide(NodeServices.layer)))),
);

it.effect("aborts an outstanding webhook when its delivery is interrupted", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<AbortSignal>();
    const service = yield* Delivery.Delivery;
    const request = yield* service.webhook({ url: "https://example.com/events" }, "{}").pipe(
      Effect.provideService(FetchHttpClient.Fetch, (_, init) => {
        const signal = init?.signal;
        if (!signal) throw new Error("Missing cancellation signal");
        Deferred.doneUnsafe(entered, Effect.succeed(signal));
        return new Promise<Response>((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
        );
      }),
      Effect.forkChild,
    );
    const signal = yield* Deferred.await(entered);
    yield* Fiber.interrupt(request);
    expect(signal.aborted).toBe(true);
  }).pipe(Effect.provide(Delivery.layer.pipe(Layer.provide(NodeServices.layer)))),
);
