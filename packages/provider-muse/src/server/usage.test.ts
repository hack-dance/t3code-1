import { describe, expect, it } from "vite-plus/test";
import { museUsageFormat } from "./usage.ts";

const record = {
  schema_version: 1,
  id: "record-1",
  stream: { kind: "session", id: "session-1" },
  sequence: 1,
  recorded_at: 1785578400123456,
  record_type: "event",
  payload_type: "runtime.session",
  payload: {
    kind: "run",
    run_id: "run-1",
    event: {
      kind: "model_completed",
      model: "muse-wonder-1.0",
      duration_ms: 500,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cached_tokens: 30,
        cache_read_tokens: 30,
        cache_write_tokens: 10,
        reasoning_tokens: 5,
      },
    },
  },
};

describe("Muse usage", () => {
  it("parses model completions with microsecond timestamps and unknown cost", () => {
    const results = museUsageFormat.parseLine(JSON.stringify(record), undefined);
    expect(results).toEqual([
      {
        provider: "muse",
        sessionId: "session-1",
        model: "muse-wonder-1.0",
        timestampMs: 1785578400123,
        reportedCostUsd: null,
        speed: "standard",
        dedupeKey: "muse:record-1",
        totals: {
          uncachedInputTokens: 60,
          cachedInputTokens: 30,
          cacheCreationTokens: 10,
          outputTokens: 20,
          reasoningTokens: 5,
        },
      },
    ]);
    expect(museUsageFormat.parseProjected(record, undefined)).toEqual(results);
  });

  it("ignores attribution duplicates and malformed or unattributable records", () => {
    for (const line of [
      "{broken",
      "null",
      "{}",
      JSON.stringify({ ...record, id: "" }),
      JSON.stringify({ ...record, stream: { kind: "session" } }),
      JSON.stringify({ ...record, recorded_at: "invalid" }),
      JSON.stringify({
        ...record,
        payload: {
          ...record.payload,
          event: { ...record.payload.event, kind: "goal_usage_attribution" },
        },
      }),
    ]) {
      expect(museUsageFormat.parseLine(line, undefined)).toEqual([]);
    }
  });

  it("uses cached_tokens as a fallback without adding overlapping cache counters", () => {
    const usage = { input_tokens: 100, output_tokens: 10, cached_tokens: 25, reasoning_tokens: 50 };
    const [result] = museUsageFormat.parseProjected(
      { ...record, payload: { ...record.payload, event: { ...record.payload.event, usage } } },
      undefined,
    );
    expect(result?.totals).toEqual({
      uncachedInputTokens: 75,
      cachedInputTokens: 25,
      cacheCreationTokens: 0,
      outputTokens: 10,
      reasoningTokens: 10,
    });
  });
});
