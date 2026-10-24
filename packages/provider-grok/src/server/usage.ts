import type { UsageTokenTotals } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  parseTimestampMs,
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";

import type { GrokSettings } from "../settings.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

/**
 * Grok reports cost in integer ticks where `1 USD = 10^10` ticks. See Grok
 * headless `total_cost_usd_ticks`.
 */
export const GROK_COST_USD_TICKS_PER_DOLLAR = 10_000_000_000;

function grokCostTicksToUsd(ticks: unknown): number | null {
  if (typeof ticks !== "number" || !Number.isFinite(ticks) || ticks < 0) return null;
  return ticks / GROK_COST_USD_TICKS_PER_DOLLAR;
}

interface GrokUsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly reasoningTokens: number;
  readonly costUsdTicks: number | null;
}

function readGrokUsageTotals(value: unknown): GrokUsageTotals | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  return {
    inputTokens: tokenCount(record["inputTokens"]),
    outputTokens: tokenCount(record["outputTokens"]),
    cachedReadTokens: tokenCount(record["cachedReadTokens"]),
    cacheCreationTokens: tokenCount(record["cacheCreationTokens"]),
    reasoningTokens: tokenCount(record["reasoningTokens"]),
    costUsdTicks:
      typeof record["costUsdTicks"] === "number" && Number.isFinite(record["costUsdTicks"])
        ? record["costUsdTicks"]
        : null,
  };
}

function grokTotalsToUsage(totals: GrokUsageTotals): UsageTokenTotals {
  const cachedInputTokens = totals.cachedReadTokens;
  const cacheCreationTokens = totals.cacheCreationTokens;
  // Grok reports `inputTokens` inclusive of the cached portion, matching Codex.
  const uncachedInputTokens = Math.max(
    0,
    totals.inputTokens - cachedInputTokens - cacheCreationTokens,
  );
  const outputTokens = totals.outputTokens;
  return {
    uncachedInputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens: Math.min(outputTokens, totals.reasoningTokens),
  };
}

export function parseGrokLine(line: string): readonly UsageRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  return parseGrokRecord(parsed);
}

function parseGrokRecord(parsed: unknown): readonly UsageRecord[] {
  if (typeof parsed !== "object" || parsed === null) return [];

  const record = parsed as Record<string, unknown>;
  const params = record["params"];
  if (typeof params !== "object" || params === null) return [];
  const paramsRecord = params as Record<string, unknown>;

  const update = paramsRecord["update"];
  if (typeof update !== "object" || update === null) return [];
  const updateRecord = update as Record<string, unknown>;
  if (updateRecord["sessionUpdate"] !== "turn_completed") return [];

  const usage = updateRecord["usage"];
  if (typeof usage !== "object" || usage === null) return [];
  const usageRecord = usage as Record<string, unknown>;

  const sessionId = typeof paramsRecord["sessionId"] === "string" ? paramsRecord["sessionId"] : "";
  const promptId = typeof updateRecord["prompt_id"] === "string" ? updateRecord["prompt_id"] : null;

  const meta = paramsRecord["_meta"];
  let timestampMs: number | null = null;
  if (typeof meta === "object" && meta !== null) {
    const agentTimestampMs = (meta as Record<string, unknown>)["agentTimestampMs"];
    if (typeof agentTimestampMs === "number" && Number.isFinite(agentTimestampMs)) {
      timestampMs = agentTimestampMs;
    }
  }
  if (timestampMs === null) {
    const timestamp = record["timestamp"];
    if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
      timestampMs = timestamp > 1e12 ? timestamp : timestamp * 1000;
    }
  }
  if (timestampMs === null) return [];

  const topLevel = readGrokUsageTotals(usageRecord);
  if (topLevel === null) return [];

  const modelUsage = usageRecord["modelUsage"];
  const modelEntries: Array<{ model: string; totals: GrokUsageTotals }> = [];
  if (typeof modelUsage === "object" && modelUsage !== null) {
    for (const [model, raw] of Object.entries(modelUsage as Record<string, unknown>)) {
      if (model.length === 0) continue;
      const totals = readGrokUsageTotals(raw);
      if (totals === null) continue;
      modelEntries.push({ model, totals });
    }
  }

  if (modelEntries.length === 0) {
    if (totalTokens(grokTotalsToUsage(topLevel)) === 0) return [];
    return [
      {
        provider: "grok",
        timestampMs,
        model: "grok",
        sessionId,
        totals: grokTotalsToUsage(topLevel),
        reportedCostUsd: grokCostTicksToUsd(topLevel.costUsdTicks),
        speed: "standard",
        // No prompt id means we cannot tell two same-second updates apart.
        dedupeKey: promptId === null ? null : `${sessionId}:${promptId}:grok`,
      },
    ];
  }

  const topLevelCostUsd = grokCostTicksToUsd(topLevel.costUsdTicks);
  let usedTickedCostUsd = 0;
  let untickedTokenDenominator = 0;
  for (const entry of modelEntries) {
    const tokens = totalTokens(grokTotalsToUsage(entry.totals));
    if (tokens === 0) continue;
    if (entry.totals.costUsdTicks !== null) {
      usedTickedCostUsd += grokCostTicksToUsd(entry.totals.costUsdTicks) ?? 0;
    } else {
      untickedTokenDenominator += tokens;
    }
  }
  const remainingCostUsd =
    topLevelCostUsd === null ? null : Math.max(0, topLevelCostUsd - usedTickedCostUsd);

  const results: UsageRecord[] = [];
  for (const entry of modelEntries) {
    const totals = grokTotalsToUsage(entry.totals);
    if (totalTokens(totals) === 0) continue;

    let reportedCostUsd = grokCostTicksToUsd(entry.totals.costUsdTicks);
    if (reportedCostUsd === null && remainingCostUsd !== null && untickedTokenDenominator > 0) {
      reportedCostUsd = remainingCostUsd * (totalTokens(totals) / untickedTokenDenominator);
    }

    results.push({
      provider: "grok",
      timestampMs,
      model: entry.model,
      sessionId,
      totals,
      reportedCostUsd,
      speed: "standard",
      dedupeKey: promptId === null ? null : `${sessionId}:${promptId}:${entry.model}`,
    });
  }
  return results;
}

export const grokUsageFormat: TranscriptUsageFormat<void> = {
  selectFields: {
    timestamp: true,
    params: {
      sessionId: true,
      _meta: { agentTimestampMs: true },
      update: { sessionUpdate: true, prompt_id: true, usage: true },
    },
  },
  usageMarkers: ['"turn_completed"'],
  parseLine: (line) => parseGrokLine(line),
  parseProjected: (projected) => parseGrokRecord(projected),
};

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const isModelUpdate = Schema.is(
  Schema.Struct({
    method: Schema.Literal("session/update"),
    params: Schema.Struct({
      sessionId: Schema.String,
      update: Schema.Struct({
        sessionUpdate: Schema.Literal("user_message_chunk"),
        _meta: Schema.Struct({ modelId: Schema.String, promptIndex: Schema.Number }),
      }),
    }),
  }),
);

function collectTurnModel(line: string, models: Map<string, string>): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (!isModelUpdate(parsed)) return;
  const { sessionId, update } = parsed.params;
  const { modelId, promptIndex } = update._meta;
  if (!Number.isSafeInteger(promptIndex) || promptIndex < 0 || !modelId.trim()) return;
  // Update prompt indexes are zero-based; usage.json turn numbers are one-based.
  models.set(sessionId + ":" + (promptIndex + 1), modelId);
}

function parseGrokUsageDocument(
  document: unknown,
  summary: unknown,
  models: ReadonlyMap<string, string>,
): readonly UsageRecord[] {
  if (typeof document !== "object" || document === null) return [];
  const { sessionId, turns } = document as Record<string, unknown>;
  if (typeof sessionId !== "string" || sessionId.length === 0 || !Array.isArray(turns)) return [];
  const currentModel =
    typeof summary === "object" && summary !== null
      ? (summary as Record<string, unknown>)["current_model_id"]
      : undefined;
  let latestTurn = 0;
  for (const turn of turns) {
    if (typeof turn !== "object" || turn === null) continue;
    const { turnNumber } = turn as Record<string, unknown>;
    if (typeof turnNumber === "number" && Number.isSafeInteger(turnNumber)) {
      latestTurn = Math.max(latestTurn, turnNumber);
    }
  }
  const summaryModel =
    typeof currentModel === "string" && currentModel.trim() ? currentModel : "unknown";
  const records: UsageRecord[] = [];
  const seen = new Set<number>();
  for (const turn of turns) {
    if (typeof turn !== "object" || turn === null) continue;
    const { turnNumber, endedAt } = turn as Record<string, unknown>;
    if (
      typeof turnNumber !== "number" ||
      !Number.isSafeInteger(turnNumber) ||
      turnNumber < 1 ||
      seen.has(turnNumber)
    )
      continue;
    const timestampMs = parseTimestampMs(endedAt);
    const usage = readGrokUsageTotals(turn);
    if (timestampMs === null || usage === null) continue;
    const totals = grokTotalsToUsage(usage);
    if (totalTokens(totals) === 0) continue;
    seen.add(turnNumber);
    records.push({
      provider: "grok",
      timestampMs,
      model:
        models.get(sessionId + ":" + turnNumber) ??
        (turnNumber === latestTurn ? summaryModel : "unknown"),
      sessionId,
      totals,
      reportedCostUsd: grokCostTicksToUsd(usage.costUsdTicks),
      speed: "standard",
      dedupeKey: sessionId + ":" + turnNumber,
    });
  }
  return records;
}

export const grokUsageReader: ProviderUsageReader<GrokSettings, Path.Path | FileSystem.FileSystem> =
  {
    kind: "scan",
    provider: "grok",
    scan: Effect.fn("grokUsageReader.scan")(function* ({ instances, windowStartMs }) {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const homeDirectory = yield* HostProcess.HomeDirectory;
      const roots = new Set(
        instances.map(({ environment }) =>
          path.resolve(
            expandHomePath(
              environment.GROK_HOME?.trim() || path.join(homeDirectory, ".grok"),
              homeDirectory,
            ),
            "sessions",
          ),
        ),
      );
      return yield* Effect.forEach(
        roots,
        Effect.fn("grokUsageReader.readRoot")(function* (dir) {
          let partial = false;
          const readDirectory = Effect.fn("grokUsageReader.readDirectory")(function* (
            directory: string,
          ) {
            return yield* fs.readDirectory(directory).pipe(
              Effect.catch(() => {
                partial = true;
                return Effect.succeed([] as string[]);
              }),
            );
          });
          const readJson = Effect.fn("grokUsageReader.readJson")(function* (file: string) {
            return yield* fs.readFileString(file).pipe(
              Effect.flatMap(decodeJson),
              Effect.catch(() => {
                partial = true;
                return Effect.succeed(null);
              }),
            );
          });
          const exists = yield* fs.exists(dir).pipe(
            Effect.catch(() => {
              partial = true;
              return Effect.succeed(false);
            }),
          );
          if (!exists)
            return { dir, files: null, status: partial ? ("partial" as const) : ("ok" as const) };
          const files: Array<{ path: string; records: readonly UsageRecord[] }> = [];
          // Current CLI layout is sessions/<encoded cwd>/<session id>.
          for (const project of yield* readDirectory(dir)) {
            const projectDir = path.join(dir, project);
            for (const session of yield* readDirectory(projectDir)) {
              const sessionDir = path.join(projectDir, session);
              const names = yield* readDirectory(sessionDir);
              let records: readonly UsageRecord[];
              let file: string;
              if (names.includes("usage.json")) {
                file = path.join(sessionDir, "usage.json");
                // Suppress the previous transcript cache too, including a now-deleted mirror.
                files.push({ path: path.join(sessionDir, "updates.jsonl"), records: [] });
                const usage = yield* readJson(file);
                const summary = names.includes("summary.json")
                  ? yield* readJson(path.join(sessionDir, "summary.json"))
                  : null;
                // Presence owns the session even during a partial write; falling back could bill twice.
                const models = new Map<string, string>();
                if (names.includes("updates.jsonl")) {
                  yield* fs.stream(path.join(sessionDir, "updates.jsonl")).pipe(
                    Stream.decodeText(),
                    Stream.splitLines,
                    Stream.runForEach((line) => Effect.sync(() => collectTurnModel(line, models))),
                    Effect.catch(() => {
                      partial = true;
                      return Effect.void;
                    }),
                  );
                }
                records = parseGrokUsageDocument(usage, summary, models);
              } else if (names.includes("updates.jsonl")) {
                file = path.join(sessionDir, "updates.jsonl");
                const legacy: UsageRecord[] = [];
                yield* fs.stream(file).pipe(
                  Stream.decodeText(),
                  Stream.splitLines,
                  Stream.runForEach((line) =>
                    Effect.sync(() => {
                      for (const record of parseGrokLine(line)) {
                        if (record.timestampMs >= windowStartMs) legacy.push(record);
                      }
                    }),
                  ),
                  Effect.catch(() => {
                    partial = true;
                    return Effect.void;
                  }),
                );
                records = legacy;
              } else continue;
              files.push({
                path: file,
                records: records.filter((record) => record.timestampMs >= windowStartMs),
              });
            }
          }
          return {
            dir,
            files,
            status: partial ? ("partial" as const) : ("ok" as const),
            ...(partial ? { message: "Some Grok history could not be read." } : {}),
          };
        }),
        { concurrency: 4 },
      );
    }),
  };
