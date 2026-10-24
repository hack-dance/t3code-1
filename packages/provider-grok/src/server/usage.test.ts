import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect, it } from "@effect/vitest";

import { grokUsageReader, GROK_COST_USD_TICKS_PER_DOLLAR, parseGrokLine } from "./usage.ts";

describe("parseGrokLine", () => {
  function turnCompleted(overrides?: {
    sessionId?: string;
    promptId?: string;
    timestamp?: number;
    agentTimestampMs?: number;
    usage?: Record<string, unknown>;
    modelUsage?: Record<string, Record<string, unknown>> | null;
  }): string {
    const modelUsage =
      overrides && "modelUsage" in overrides
        ? overrides.modelUsage
        : {
            "grok-4.5-build": {
              inputTokens: 20_272,
              outputTokens: 272,
              totalTokens: 20_544,
              cachedReadTokens: 11_264,
              cacheCreationTokens: 0,
              reasoningTokens: 180,
              costUsdTicks: 230_272_000,
            },
          };

    return JSON.stringify({
      timestamp: overrides?.timestamp ?? 1_786_372_566,
      method: "_x.ai/session/update",
      params: {
        sessionId: overrides?.sessionId ?? "019fec1a-12f7-72f2-9b1f-7778a00aea3c",
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: overrides?.promptId ?? "prompt-1",
          stop_reason: "end_turn",
          usage: {
            inputTokens: 20_272,
            outputTokens: 272,
            totalTokens: 20_544,
            cachedReadTokens: 11_264,
            cacheCreationTokens: 0,
            reasoningTokens: 180,
            costUsdTicks: 230_272_000,
            ...(modelUsage === null ? {} : { modelUsage }),
            ...overrides?.usage,
          },
        },
        _meta: {
          eventId: "event-1",
          agentTimestampMs: overrides?.agentTimestampMs ?? 1_786_372_566_485,
        },
      },
    });
  }

  it("extracts per-model totals and provider-reported cost ticks", () => {
    const records = parseGrokLine(turnCompleted());

    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record?.provider).toBe("grok");
    expect(record?.model).toBe("grok-4.5-build");
    expect(record?.sessionId).toBe("019fec1a-12f7-72f2-9b1f-7778a00aea3c");
    expect(record?.timestampMs).toBe(1_786_372_566_485);
    expect(record?.totals).toEqual({
      uncachedInputTokens: 20_272 - 11_264,
      cachedInputTokens: 11_264,
      cacheCreationTokens: 0,
      outputTokens: 272,
      reasoningTokens: 180,
    });
    expect(record?.reportedCostUsd).toBeCloseTo(230_272_000 / GROK_COST_USD_TICKS_PER_DOLLAR, 12);
    expect(record?.dedupeKey).toBe("019fec1a-12f7-72f2-9b1f-7778a00aea3c:prompt-1:grok-4.5-build");
  });

  it("emits one record per model when modelUsage has several entries", () => {
    const records = parseGrokLine(
      turnCompleted({
        modelUsage: {
          "grok-4.5": {
            inputTokens: 1000,
            outputTokens: 50,
            cachedReadTokens: 400,
            reasoningTokens: 20,
            costUsdTicks: 50_000_000,
          },
          "grok-composer-2.5-fast": {
            inputTokens: 200,
            outputTokens: 30,
            cachedReadTokens: 100,
            reasoningTokens: 0,
            costUsdTicks: 10_000_000,
          },
        },
      }),
    );

    expect(records.map((record) => record.model).toSorted()).toEqual([
      "grok-4.5",
      "grok-composer-2.5-fast",
    ]);
    expect(records.every((record) => record.provider === "grok")).toBe(true);
    expect(records.find((record) => record.model === "grok-4.5")?.reportedCostUsd).toBeCloseTo(
      0.005,
      12,
    );
  });

  it("inherits top-level cost ticks for a single model without its own ticks", () => {
    const records = parseGrokLine(
      turnCompleted({
        modelUsage: {
          "grok-4.5-build": {
            inputTokens: 1000,
            outputTokens: 10,
            cachedReadTokens: 0,
            reasoningTokens: 0,
          },
        },
        usage: { costUsdTicks: GROK_COST_USD_TICKS_PER_DOLLAR },
      }),
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.reportedCostUsd).toBe(1);
  });

  it("falls back to a generic grok model when modelUsage is absent", () => {
    const records = parseGrokLine(turnCompleted({ modelUsage: null }));

    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record?.provider).toBe("grok");
    expect(record?.model).toBe("grok");
    expect(record?.totals).toEqual({
      uncachedInputTokens: 20_272 - 11_264,
      cachedInputTokens: 11_264,
      cacheCreationTokens: 0,
      outputTokens: 272,
      reasoningTokens: 180,
    });
    expect(record?.reportedCostUsd).toBeCloseTo(230_272_000 / GROK_COST_USD_TICKS_PER_DOLLAR, 12);
    expect(record?.dedupeKey).toBe("019fec1a-12f7-72f2-9b1f-7778a00aea3c:prompt-1:grok");
  });

  it("pro-rates top-level cost ticks across multi-model turns without per-model ticks", () => {
    const records = parseGrokLine(
      turnCompleted({
        modelUsage: {
          "grok-4.5": {
            inputTokens: 300,
            outputTokens: 0,
            cachedReadTokens: 0,
            reasoningTokens: 0,
          },
          "grok-composer-2.5-fast": {
            inputTokens: 100,
            outputTokens: 0,
            cachedReadTokens: 0,
            reasoningTokens: 0,
          },
        },
        usage: { costUsdTicks: GROK_COST_USD_TICKS_PER_DOLLAR },
      }),
    );

    expect(records).toHaveLength(2);
    const byModel = Object.fromEntries(records.map((record) => [record.model, record]));
    expect(byModel["grok-4.5"]?.reportedCostUsd).toBeCloseTo(0.75, 12);
    expect(byModel["grok-composer-2.5-fast"]?.reportedCostUsd).toBeCloseTo(0.25, 12);
    const sum =
      (byModel["grok-4.5"]?.reportedCostUsd ?? 0) +
      (byModel["grok-composer-2.5-fast"]?.reportedCostUsd ?? 0);
    expect(sum).toBeCloseTo(1, 12);
  });

  it("allocates leftover aggregate ticks to models that omit per-model ticks", () => {
    const records = parseGrokLine(
      turnCompleted({
        modelUsage: {
          "grok-4.5": {
            inputTokens: 300,
            outputTokens: 0,
            cachedReadTokens: 0,
            reasoningTokens: 0,
            costUsdTicks: 0.4 * GROK_COST_USD_TICKS_PER_DOLLAR,
          },
          "grok-composer-2.5-fast": {
            inputTokens: 100,
            outputTokens: 0,
            cachedReadTokens: 0,
            reasoningTokens: 0,
          },
        },
        usage: { costUsdTicks: GROK_COST_USD_TICKS_PER_DOLLAR },
      }),
    );

    expect(records).toHaveLength(2);
    const byModel = Object.fromEntries(records.map((record) => [record.model, record]));
    expect(byModel["grok-4.5"]?.reportedCostUsd).toBeCloseTo(0.4, 12);
    expect(byModel["grok-composer-2.5-fast"]?.reportedCostUsd).toBeCloseTo(0.6, 12);
    const sum =
      (byModel["grok-4.5"]?.reportedCostUsd ?? 0) +
      (byModel["grok-composer-2.5-fast"]?.reportedCostUsd ?? 0);
    expect(sum).toBeCloseTo(1, 12);
  });

  it("does not invent a colliding dedupe key when prompt_id is missing", () => {
    const line = JSON.stringify({
      timestamp: 1_786_372_566,
      method: "_x.ai/session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "turn_completed",
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            modelUsage: {
              "grok-4.5": { inputTokens: 10, outputTokens: 2 },
            },
          },
        },
      },
    });

    expect(parseGrokLine(line)[0]?.dedupeKey).toBeNull();
  });

  it("ignores non-turn lines and empty usage", () => {
    expect(parseGrokLine(JSON.stringify({ method: "session/update", params: {} }))).toEqual([]);
    expect(parseGrokLine("not json")).toEqual([]);
    expect(
      parseGrokLine(
        turnCompleted({
          modelUsage: {
            "grok-4.5-build": {
              inputTokens: 0,
              outputTokens: 0,
              cachedReadTokens: 0,
              reasoningTokens: 0,
              costUsdTicks: 0,
            },
          },
        }),
      ),
    ).toEqual([]);
  });

  it("falls back to the outer unix-seconds timestamp when agent meta is missing", () => {
    const line = JSON.stringify({
      timestamp: 1_786_372_566,
      method: "_x.ai/session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: "p1",
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            modelUsage: {
              "grok-4.5": { inputTokens: 10, outputTokens: 2 },
            },
          },
        },
      },
    });

    const records = parseGrokLine(line);
    expect(records[0]?.timestampMs).toBe(1_786_372_566_000);
  });
});

describe("grokUsageReader", () => {
  const turn = (turnNumber: number, inputTokens = 100) => ({
    turnNumber,
    endedAt: "2026-10-24T03:37:06.911188+00:00",
    inputTokens,
    outputTokens: inputTokens === 0 ? 0 : 20,
    cachedReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    totalTokens: inputTokens === 0 ? 0 : 120,
    modelCalls: 1,
    turnCount: 1,
  });
  const legacy = JSON.stringify({
    timestamp: 1792813026,
    params: {
      sessionId: "s1",
      update: {
        sessionUpdate: "turn_completed",
        prompt_id: "p1",
        usage: { inputTokens: 100, outputTokens: 20 },
      },
    },
  });
  const scan = Effect.fn("test.scanGrok")(function* (files: Record<string, string>) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "grok-usage-synthetic-" });
    for (const [name, contents] of Object.entries(files)) {
      const destination = path.join(home, "sessions", "%2Fsynthetic", name);
      yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
      yield* fs.writeFileString(destination, contents);
    }
    if (grokUsageReader.kind !== "scan") throw new Error("Expected a Grok scan reader");
    return yield* grokUsageReader
      .scan({
        instances: [
          {
            instanceId: ProviderInstanceId.make("grok"),
            config: undefined,
            environment: { GROK_HOME: home },
            configured: true,
          },
        ],
        settings: DEFAULT_SERVER_SETTINGS,
        windowStartMs: 0,
        retentionCutoffMs: 0,
        awaitRefresh: true,
      })
      .pipe(Effect.provideService(HostProcess.HomeDirectory, home));
  });
  const usage = (turns: unknown[]) =>
    JSON.stringify({ sessionId: "s1", updatedAt: "2026-10-24T03:37:06Z", session: turn(1), turns });

  it.effect(
    "does not move the summary fallback to older turns when the latest turn has no tokens",
    () =>
      Effect.gen(function* () {
        const sources = yield* scan({
          "s1/usage.json": usage([turn(1), turn(2), turn(3, 0), turn(1)]),
          "s1/summary.json": JSON.stringify({
            current_model_id: "grok-4.7",
            created_at: "2026-10-24T03:00:00Z",
          }),
        });
        const records = sources.flatMap(
          (source) => source.files?.flatMap((file) => file.records) ?? [],
        );
        expect(records).toHaveLength(2);
        expect(records.map((record) => record.model)).toEqual(["unknown", "unknown"]);
        expect(records.map((record) => record.dedupeKey)).toEqual(["s1:1", "s1:2"]);
        expect(records[0]).toMatchObject({
          model: "unknown",
          timestampMs: Date.parse("2026-10-24T03:37:06.911Z"),
          totals: { uncachedInputTokens: 100, outputTokens: 20 },
        });
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "attributes models by prompt index and limits summary fallback to the latest turn",
    () =>
      Effect.gen(function* () {
        const update = (promptIndex: unknown, modelId: string, sessionId = "s1") =>
          JSON.stringify({
            timestamp: 1792813026,
            method: "session/update",
            params: {
              sessionId,
              update: { sessionUpdate: "user_message_chunk", _meta: { modelId, promptIndex } },
            },
          });
        const sources = yield* scan({
          "s1/usage.json": usage([turn(4), turn(1), turn(2), turn(3)]),
          "s1/summary.json": JSON.stringify({ current_model_id: "grok-4.7" }),
          "s1/updates.jsonl": [
            update(0, "grok-4.6"),
            update(1, "grok-4.5"),
            update(2, "wrong-session", "other"),
            update("2", "invalid-index"),
            update(2, " "),
            "{",
            "null",
            legacy,
          ].join("\n"),
        });
        const records = sources.flatMap(
          (source) => source.files?.flatMap((file) => file.records) ?? [],
        );
        expect(records.map(({ dedupeKey, model }) => [dedupeKey, model])).toEqual([
          ["s1:4", "grok-4.7"],
          ["s1:1", "grok-4.6"],
          ["s1:2", "grok-4.5"],
          ["s1:3", "unknown"],
        ]);
        const explicit = yield* scan({
          "s1/usage.json": usage([turn(1)]),
          "s1/summary.json": JSON.stringify({ current_model_id: "grok-4.7" }),
          "s1/updates.jsonl": update(0, "grok-4.6"),
        });
        expect(
          explicit.flatMap((source) => source.files?.flatMap((file) => file.records) ?? [])[0]
            ?.model,
        ).toBe("grok-4.6");
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uses updates.jsonl token totals only for sessions without usage.json", () =>
    Effect.gen(function* () {
      const sources = yield* scan({
        "s1/usage.json": usage([turn(1)]),
        "s1/updates.jsonl": legacy,
        "old/updates.jsonl": legacy.replaceAll("s1", "old"),
      });
      const records = sources.flatMap(
        (source) => source.files?.flatMap((file) => file.records) ?? [],
      );
      expect(records).toHaveLength(2);
      expect(
        sources[0]?.files?.find((file) => file.path.endsWith("s1/updates.jsonl"))?.records,
      ).toEqual([]);
      expect(records.find((record) => record.sessionId === "s1")?.model).toBe("unknown");
      expect(records.find((record) => record.sessionId === "old")?.totals.outputTokens).toBe(20);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("tolerates malformed usage and summary without billing the legacy mirror", () =>
    Effect.gen(function* () {
      const sources = yield* scan({
        "bad/usage.json": "{",
        "bad/updates.jsonl": legacy,
        "good/usage.json": usage([null, {}, { ...turn(1), endedAt: "invalid" }, turn(2)]),
        "good/summary.json": "{",
        "old/updates.jsonl": "not json\n",
      });
      const records = sources.flatMap(
        (source) => source.files?.flatMap((file) => file.records) ?? [],
      );
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ model: "unknown", dedupeKey: "s1:2" });
      expect(sources[0]?.status).toBe("partial");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
