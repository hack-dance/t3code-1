import * as NodeEvents from "node:events";

import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { afterEach, vi } from "vite-plus/test";

import * as ProjectEventSink from "./ProjectEventSink.ts";

const spawn = vi.hoisted(() => vi.fn());
const fetchStub = vi.fn<typeof globalThis.fetch>();
vi.mock("node:child_process", () => ({ spawn }));
afterEach(() => {
  vi.resetAllMocks();
});

const input = {
  context: { sourceLabel: "host-a", targetLabel: "build-box" },
  projectName: "example-project",
  remoteUrl: "https://example-user:example-password@example.com/team/project.git?token=example#key",
  destinationPath: "/workspace/project",
  files: [".env", "config/.env.local"],
};

function layer(config?: unknown) {
  return ProjectEventSink.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchStub)),
    Layer.provide(
      FileSystem.layerNoop({
        readFileString: () => Effect.succeed(JSON.stringify(config)),
      }),
    ),
    Layer.provide(
      Layer.succeed(HostProcess.Environment, {
        ...(config === undefined ? {} : { T3CODE_EVENT_HOOKS_CONFIG: "/config/hooks.json" }),
        EXAMPLE_HOOK_HEADER: "example-header-value",
      }),
    ),
  );
}

describe("ProjectEventSink", () => {
  it.effect.each(["http", "https"] as const)(
    "omits a backslash authority from both hook deliveries for %s",
    (protocol) =>
      Effect.gen(function* () {
        const posted = Deferred.makeUnsafe<RequestInit>();
        const piped = Deferred.makeUnsafe<string>();
        fetchStub.mockImplementation((_url, options) => {
          Deferred.doneUnsafe(posted, Effect.succeed(options!));
          return Promise.resolve(new Response(null, { status: 204 }));
        });
        spawn.mockReturnValue(
          Object.assign(new NodeEvents.EventEmitter(), {
            stdin: Object.assign(new NodeEvents.EventEmitter(), {
              end: (json: string) => Deferred.doneUnsafe(piped, Effect.succeed(json)),
            }),
            exitCode: null,
            signalCode: null,
            kill: vi.fn(),
          }),
        );
        const sink = yield* ProjectEventSink.ProjectEventSink;
        yield* sink.filesCopied({
          ...input,
          remoteUrl: `${protocol}://example-domain\\example-user:EXAMPLE_PASSWORD@example.com/repo.git`,
        });
        const request = yield* Deferred.await(posted);
        const stdin = yield* Deferred.await(piped);
        for (const json of [new TextDecoder().decode(request.body as Uint8Array), stdin]) {
          expect(JSON.parse(json).repo).toEqual({ projectName: input.projectName });
          expect(json).not.toContain("EXAMPLE_PASSWORD");
          expect(json).not.toContain("example-user");
        }
      }).pipe(
        Effect.provide(
          layer({
            webhook: { url: "https://example.com/events" },
            command: { executable: "event-hook" },
          }),
        ),
      ),
  );

  it.effect.each(["constructor", "toString", "MISSING_ENV"])(
    "skips a webhook when %s is not an own environment variable",
    (env) =>
      Effect.gen(function* () {
        fetchStub.mockResolvedValue(new Response(null, { status: 204 }));
        const sink = yield* ProjectEventSink.ProjectEventSink;
        yield* sink.filesCopied(input);
        yield* TestClock.adjust(100);
        expect(fetchStub).not.toHaveBeenCalled();
      }).pipe(
        Effect.provide(
          layer({
            timeoutMs: 100,
            webhook: { url: "https://example.com/events", header: { name: "X-Event-Key", env } },
          }),
        ),
      ),
  );

  it.effect.each([
    "https://example-user:EXAMPLE_PASSWORD@[invalid]/repo.git",
    "ssh://example-user:EXAMPLE_PASSWORD@[invalid]/repo.git",
    "git://example-user:EXAMPLE_PASSWORD@[invalid]/repo.git",
    "  HTTPS://example-user:EXAMPLE_PASSWORD@[invalid]/repo.git  ",
    "https:\\\\example-user:EXAMPLE_PASSWORD@[invalid]\\repo.git",
    "ssh:example-user:EXAMPLE_PASSWORD@example.com/repo.git",
    "git:example-user:EXAMPLE_PASSWORD@example.com/repo.git",
    "ssh:/example-user:EXAMPLE_PASSWORD@example.com/repo.git",
    "git:/example-user:EXAMPLE_PASSWORD@example.com/repo.git",
    "https:example-user:EXAMPLE_PASSWORD@example.com/repo.git",
    "https:///example-user:EXAMPLE_PASSWORD@example.com/repo.git",
    "ssh:///example-user:EXAMPLE_PASSWORD@example.com/repo.git",
    "git:///example-user:EXAMPLE_PASSWORD@example.com/repo.git",
  ])("omits malformed or ambiguous scheme URLs: %s", (remoteUrl) =>
    Effect.gen(function* () {
      const received = Deferred.makeUnsafe<RequestInit>();
      fetchStub.mockImplementation((_url, options) => {
        Deferred.doneUnsafe(received, Effect.succeed(options!));
        return Promise.resolve(new Response(null, { status: 204 }));
      });
      const sink = yield* ProjectEventSink.ProjectEventSink;
      yield* sink.filesCopied({ ...input, remoteUrl });
      const request = yield* Deferred.await(received);
      const json = new TextDecoder().decode(request.body as Uint8Array);
      expect(JSON.parse(json).repo).toEqual({ projectName: input.projectName });
      expect(json).not.toContain("EXAMPLE_PASSWORD");
      expect(json).not.toContain("example-user");
    }).pipe(Effect.provide(layer({ webhook: { url: "https://example.com/events" } }))),
  );

  it.effect.each(["ssh", "git"] as const)(
    "strips credentials from a valid %s URL with an authority",
    (protocol) =>
      Effect.gen(function* () {
        const received = Deferred.makeUnsafe<RequestInit>();
        fetchStub.mockImplementation((_url, options) => {
          Deferred.doneUnsafe(received, Effect.succeed(options!));
          return Promise.resolve(new Response(null, { status: 204 }));
        });
        const sink = yield* ProjectEventSink.ProjectEventSink;
        yield* sink.filesCopied({
          ...input,
          remoteUrl: `${protocol}://example-user:EXAMPLE_PASSWORD@example.com:2222/repo.git?key=EXAMPLE_PASSWORD#EXAMPLE_PASSWORD`,
        });
        const request = yield* Deferred.await(received);
        const json = new TextDecoder().decode(request.body as Uint8Array);
        expect(JSON.parse(json).repo.remoteUrl).toBe(`${protocol}://example.com:2222/repo.git`);
        expect(json).not.toMatch(/example-user|EXAMPLE_PASSWORD/);
      }).pipe(Effect.provide(layer({ webhook: { url: "https://example.com/events" } }))),
  );

  it.effect.each(["invalid-argument", "missing-executable"] as const)(
    "keeps command paths, arguments, and failures out of recorded traces on %s",
    (outcome) => {
      const spans: Tracer.NativeSpan[] = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const command = {
        executable: "./.t3/EXAMPLE_PRIVATE_EXECUTABLE",
        args: outcome === "invalid-argument" ? ["--token=EXAMPLE_SECRET\u0000"] : [],
      };
      return Effect.gen(function* () {
        const actual = yield* Effect.promise(() =>
          vi.importActual<typeof import("node:child_process")>("node:child_process"),
        );
        const failed = Deferred.makeUnsafe<void>();
        const failures: Error[] = [];
        spawn.mockImplementation((executable, args, options) => {
          try {
            const child = actual.spawn(executable, args, options);
            child.once("error", (error) => {
              failures.push(error);
              Deferred.doneUnsafe(failed, Effect.void);
            });
            return child;
          } catch (error) {
            if (error instanceof Error) failures.push(error);
            Deferred.doneUnsafe(failed, Effect.void);
            throw error;
          }
        });
        yield* Effect.void.pipe(Effect.withSpan("test.trace-control"));
        yield* Effect.gen(function* () {
          const sink = yield* ProjectEventSink.ProjectEventSink;
          yield* sink.filesCopied(input);
          yield* Deferred.await(failed);
          yield* TestClock.adjust(100);
        }).pipe(Effect.provide(layer({ command, timeoutMs: 100 })));
        expect(spawn).toHaveBeenCalledOnce();
        expect(failures).toHaveLength(1);
        expect(failures[0]?.message).toContain(
          outcome === "invalid-argument" ? "EXAMPLE_SECRET" : "EXAMPLE_PRIVATE_EXECUTABLE",
        );
        expect(spans.some((span) => span.name === "test.trace-control")).toBe(true);
        const recorded = spans.map((span) => ({
          name: span.name,
          attributes: Object.fromEntries(span.attributes),
          events: span.events,
          failure:
            span.status._tag === "Ended" && Exit.isFailure(span.status.exit)
              ? Cause.pretty(span.status.exit.cause)
              : null,
        }));
        expect(JSON.stringify(recorded)).not.toMatch(/EXAMPLE_SECRET|EXAMPLE_PRIVATE_EXECUTABLE/);
        expect(spans.some((span) => span.name === "ProjectEventSink.runCommand")).toBe(false);
      }).pipe(Effect.withTracer(tracer), Effect.withTracerEnabled(true));
    },
  );

  it.effect.each(["success", "http-error", "transport-error", "timeout"] as const)(
    "keeps webhook URLs, headers, and failures out of recorded traces on %s",
    (outcome) => {
      const spans: Tracer.NativeSpan[] = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const url = "https://example.com/EXAMPLE_HOOK_SECRET_PATH?key=EXAMPLE_HOOK_SECRET_QUERY";
      return Effect.gen(function* () {
        const started = Deferred.makeUnsafe<RequestInit>();
        const requests: RequestInit[] = [];
        fetchStub.mockImplementation((target, options) => {
          expect(String(target)).toBe(url);
          requests.push(options!);
          Deferred.doneUnsafe(started, Effect.succeed(options!));
          if (outcome === "transport-error") {
            return Promise.reject(new Error(`EXAMPLE_HOOK_SECRET_FAILURE ${target}`));
          }
          if (outcome === "timeout") return new Promise(() => {});
          return Promise.resolve(
            new Response(null, { status: outcome === "http-error" ? 500 : 204 }),
          );
        });
        yield* Effect.void.pipe(Effect.withSpan("test.trace-control"));
        yield* Effect.gen(function* () {
          const sink = yield* ProjectEventSink.ProjectEventSink;
          yield* sink.filesCopied(input);
          const request = yield* Deferred.await(started);
          expect(new Headers(request.headers).get("X-Event-Key")).toBe("example-header-value");
          yield* TestClock.adjust(100);
        }).pipe(
          Effect.provide(
            layer({
              timeoutMs: 100,
              webhook: { url, header: { name: "X-Event-Key", env: "EXAMPLE_HOOK_HEADER" } },
            }),
          ),
        );
        expect(spans.some((span) => span.name === "test.trace-control")).toBe(true);
        const recorded = spans.map((span) => ({
          name: span.name,
          attributes: Object.fromEntries(span.attributes),
          events: span.events,
          failure:
            span.status._tag === "Ended" && Exit.isFailure(span.status.exit)
              ? Cause.pretty(span.status.exit.cause)
              : null,
        }));
        expect(JSON.stringify(recorded)).not.toMatch(/EXAMPLE_HOOK_SECRET|example-header-value/);
        expect(spans.some((span) => span.name.startsWith("http."))).toBe(false);
        expect(new Headers(requests[0]?.headers).has("traceparent")).toBe(false);
      }).pipe(Effect.withTracer(tracer), Effect.withTracerEnabled(true));
    },
  );

  it.effect("drops events above the 32-event limit and accepts events after timeout", () => {
    const messages: unknown[] = [];
    const logger = Logger.make(({ message, logLevel }) => {
      messages.push({ message, logLevel });
    });
    return Effect.gen(function* () {
      const full = Deferred.makeUnsafe<void>();
      const recovered = Deferred.makeUnsafe<void>();
      const signals: AbortSignal[] = [];
      fetchStub.mockImplementation((_url, options) => {
        signals.push(options!.signal!);
        if (signals.length === 32) Deferred.doneUnsafe(full, Effect.void);
        if (signals.length === 33) Deferred.doneUnsafe(recovered, Effect.void);
        return new Promise(() => {});
      });
      const sink = yield* ProjectEventSink.ProjectEventSink;
      yield* Effect.forEach(Array.from({ length: 32 }), () => sink.filesCopied(input), {
        concurrency: "unbounded",
      });
      yield* Deferred.await(full);
      yield* sink.filesCopied(input);
      expect(fetchStub).toHaveBeenCalledTimes(32);
      expect(messages).toEqual([
        {
          logLevel: "Debug",
          message: ["Project event delivery limit reached", { activeEvents: 32, droppedEvents: 1 }],
        },
      ]);
      yield* TestClock.adjust(100);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      yield* sink.filesCopied(input);
      yield* Deferred.await(recovered);
      expect(fetchStub).toHaveBeenCalledTimes(33);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layer({ webhook: { url: "https://example.com/events" }, timeoutMs: 100 }),
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
      Effect.provideService(References.MinimumLogLevel, "Debug"),
    );
  });

  it.effect("projects metadata only and strips URL credentials before HTTP delivery", () =>
    Effect.gen(function* () {
      const received = Deferred.makeUnsafe<RequestInit>();
      fetchStub.mockImplementation((_url, options) => {
        Deferred.doneUnsafe(received, Effect.succeed(options!));
        return Promise.resolve(new Response(null, { status: 204 }));
      });
      const sink = yield* ProjectEventSink.ProjectEventSink;
      const withContents = {
        ...input,
        contents: "EXAMPLE_PRIVATE_CONTENT=must-never-be-delivered",
        error: "must-never-be-delivered",
        files: [...input.files, "../outside", "/absolute", "C:\\outside", ".env"],
      };
      yield* sink.filesCopied(withContents);
      const request = yield* Deferred.await(received);
      const json = new TextDecoder().decode(request.body as Uint8Array);
      const payload = JSON.parse(json);
      expect(payload).toEqual({
        type: "files.copied",
        timestamp: expect.any(String),
        source: { label: "host-a" },
        target: { label: "build-box" },
        repo: {
          projectName: "example-project",
          remoteUrl: "https://example.com/team/project.git",
        },
        destinationPath: "/workspace/project",
        files: [".env", "config/.env.local"],
      });
      expect(json).not.toMatch(/must-never|example-password|example-user|token=/);
      expect(new Headers(request.headers).get("X-Event-Key")).toBe("example-header-value");
      expect(request.redirect).toBe("error");
    }).pipe(
      Effect.provide(
        layer({
          webhook: {
            url: "https://example.com/events",
            header: { name: "X-Event-Key", env: "EXAMPLE_HOOK_HEADER" },
          },
        }),
      ),
    ),
  );

  it.effect("sends literal argv and JSON stdin to a command and kills a slow hook", () =>
    Effect.gen(function* () {
      const received = Deferred.makeUnsafe<string>();
      const child = Object.assign(new NodeEvents.EventEmitter(), {
        stdin: Object.assign(new NodeEvents.EventEmitter(), {
          end: (json: string) => Deferred.doneUnsafe(received, Effect.succeed(json)),
        }),
        exitCode: null,
        signalCode: null,
        kill: vi.fn(),
      });
      spawn.mockReturnValue(child);
      const sink = yield* ProjectEventSink.ProjectEventSink;
      yield* sink.filesCopied({ ...input, remoteUrl: "example-user@example.com:team/project.git" });
      const json = yield* Deferred.await(received);
      expect(JSON.parse(json).repo.remoteUrl).toBe("ssh://example.com/team/project.git");
      expect(spawn).toHaveBeenCalledWith("event-hook", ["$(literal)", ";literal"], {
        shell: false,
        stdio: ["pipe", "ignore", "ignore"],
      });
      yield* TestClock.adjust(100);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    }).pipe(
      Effect.provide(
        layer({
          command: { executable: "event-hook", args: ["$(literal)", ";literal"] },
          timeoutMs: 100,
        }),
      ),
    ),
  );

  it.effect("does not wait for a slow webhook and aborts it at the deadline", () =>
    Effect.gen(function* () {
      const started = Deferred.makeUnsafe<AbortSignal>();
      fetchStub.mockImplementation((_url, options) => {
        Deferred.doneUnsafe(started, Effect.succeed(options!.signal!));
        return new Promise(() => {});
      });
      const sink = yield* ProjectEventSink.ProjectEventSink;
      yield* sink.filesCopied(input);
      const signal = yield* Deferred.await(started);
      expect(signal.aborted).toBe(false);
      yield* TestClock.adjust(100);
      expect(signal.aborted).toBe(true);
    }).pipe(
      Effect.provide(layer({ webhook: { url: "https://example.com/events" }, timeoutMs: 100 })),
    ),
  );

  it.effect("contains delivery failures and is off for missing or invalid configuration", () =>
    Effect.gen(function* () {
      const started = Deferred.makeUnsafe<void>();
      fetchStub.mockImplementation(() => {
        Deferred.doneUnsafe(started, Effect.void);
        return Promise.reject(new Error("unavailable"));
      });
      yield* Effect.gen(function* () {
        const sink = yield* ProjectEventSink.ProjectEventSink;
        yield* sink.filesCopied(input);
        yield* Deferred.await(started);
      }).pipe(Effect.provide(layer({ webhook: { url: "https://example.com/events" } })));
      expect(fetchStub).toHaveBeenCalledTimes(1);
      fetchStub.mockClear();
      for (const config of [undefined, {}, { timeoutMs: -1 }]) {
        yield* Effect.gen(function* () {
          const sink = yield* ProjectEventSink.ProjectEventSink;
          yield* sink.filesCopied(input);
        }).pipe(Effect.provide(layer(config)));
      }
      expect(fetchStub).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    }),
  );
});
