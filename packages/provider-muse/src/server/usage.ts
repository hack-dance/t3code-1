import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import type { MuseSettings } from "../settings.ts";

const Entry = Schema.Struct({
  id: Schema.NonEmptyString,
  stream: Schema.Struct({ kind: Schema.Literal("session"), id: Schema.NonEmptyString }),
  recorded_at: Schema.Number,
  record_type: Schema.Literal("event"),
  payload_type: Schema.Literal("runtime.session"),
  payload: Schema.Struct({
    kind: Schema.Literal("run"),
    event: Schema.Struct({
      kind: Schema.Literal("model_completed"),
      model: Schema.NonEmptyString,
      usage: Schema.Struct({
        input_tokens: Schema.optional(Schema.Unknown),
        output_tokens: Schema.optional(Schema.Unknown),
        cached_tokens: Schema.optional(Schema.Unknown),
        cache_read_tokens: Schema.optional(Schema.Unknown),
        cache_write_tokens: Schema.optional(Schema.Unknown),
        reasoning_tokens: Schema.optional(Schema.Unknown),
      }),
    }),
  }),
});
const decodeEntry = Schema.decodeUnknownOption(Entry);

function parseRecord(parsed: unknown): readonly UsageRecord[] {
  const decoded = decodeEntry(parsed);
  if (Option.isNone(decoded)) return [];
  const entry = decoded.value;
  if (!Number.isSafeInteger(entry.recorded_at) || entry.recorded_at < 0) return [];
  const { model, usage } = entry.payload.event;
  // The aggregate cached counter overlaps cache reads; never add both.
  const cachedInputTokens = tokenCount(usage.cache_read_tokens ?? usage.cached_tokens);
  const cacheCreationTokens = tokenCount(usage.cache_write_tokens);
  const outputTokens = tokenCount(usage.output_tokens);
  const totals = {
    uncachedInputTokens: Math.max(
      0,
      tokenCount(usage.input_tokens) - cachedInputTokens - cacheCreationTokens,
    ),
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens: Math.min(outputTokens, tokenCount(usage.reasoning_tokens)),
  };
  if (totalTokens(totals) === 0) return [];
  return [
    {
      provider: "muse",
      timestampMs: Math.trunc(entry.recorded_at / 1000),
      model,
      sessionId: entry.stream.id,
      totals,
      reportedCostUsd: null,
      speed: "standard",
      dedupeKey: `muse:${entry.id}`,
    },
  ];
}

export const museUsageFormat: TranscriptUsageFormat<void> = {
  selectFields: {
    id: true,
    stream: true,
    recorded_at: true,
    record_type: true,
    payload_type: true,
    payload: { kind: true, event: { kind: true, model: true, usage: true } },
  },
  usageMarkers: ['"model_completed"'],
  parseLine: (line) => {
    try {
      return parseRecord(JSON.parse(line));
    } catch {
      return [];
    }
  },
  parseProjected: parseRecord,
};

export const museUsageReader: ProviderUsageReader<MuseSettings, Path.Path> = {
  kind: "transcripts",
  provider: "muse",
  format: museUsageFormat,
  directories: Effect.fn("museUsageReader.directories")(function* () {
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    // Nested agent/tool directories qualify only through attributable session records.
    return [
      { dir: path.join(home, ".local", "share", "muse", "sessions"), fileName: "session.jsonl" },
    ];
  }),
};
