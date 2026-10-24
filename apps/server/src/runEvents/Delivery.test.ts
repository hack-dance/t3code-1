import { expect, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Tracer from "effect/Tracer";
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
      .pipe(Effect.flip, Effect.provideService(FetchHttpClient.Fetch, fetchMock));
    expect(missing.retryable).toBe(false);
    const missingAuth = yield* service
      .webhook({ url: "https://example.com", authHeaderEnv: "RUN_EVENT_TEST_MISSING" }, "{}")
      .pipe(Effect.flip, Effect.provideService(FetchHttpClient.Fetch, fetchMock));
    expect(missingAuth.retryable).toBe(false);
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

it.effect("keeps webhook URLs and credentials out of successful and failed traces", () =>
  Effect.gen(function* () {
    const spans: Array<unknown> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (time, exit) => {
          end(time, exit);
          spans.push({
            name: span.name,
            attributes: Object.fromEntries(span.attributes),
            status: span.status,
          });
        };
        return span;
      },
    });
    vi.stubEnv("RUN_EVENT_TEST_AUTH", "Bearer auth-sentinel");
    vi.stubEnv("RUN_EVENT_TEST_KEY", "signing-sentinel");
    const service = yield* Delivery.Delivery;
    for (const status of [204, 401, 503, "network"] as const) {
      const result = yield* service
        .webhook(
          {
            url: "https://example.com/path-sentinel?key=query-sentinel",
            authHeaderEnv: "RUN_EVENT_TEST_AUTH",
            hmacSecretEnv: "RUN_EVENT_TEST_KEY",
          },
          '{"type":"run.started"}',
        )
        .pipe(
          Effect.provideService(FetchHttpClient.Fetch, async () => {
            if (status === "network") throw new Error("query-sentinel");
            return new Response(null, { status });
          }),
          Effect.withTracer(tracer),
          Effect.exit,
        );
      expect(result._tag).toBe(status === 204 ? "Success" : "Failure");
    }
    expect(spans.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(spans, (_, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    expect(serialized).not.toContain("sentinel");
    expect(serialized).not.toContain("example.com");
  }).pipe(Effect.provide(Delivery.layer.pipe(Layer.provide(NodeServices.layer)))),
);

it.effect("retries only transient HTTP failures", () =>
  Effect.gen(function* () {
    const service = yield* Delivery.Delivery;
    for (const status of [400, 401, 404, 413, 408, 429, 500, 503]) {
      const error = yield* service.webhook({ url: "https://example.com" }, "{}").pipe(
        Effect.provideService(FetchHttpClient.Fetch, async () => new Response(null, { status })),
        Effect.flip,
      );
      expect(error.retryable).toBe(status === 408 || status === 429 || status >= 500);
    }
  }).pipe(Effect.provide(Delivery.layer.pipe(Layer.provide(NodeServices.layer)))),
);
