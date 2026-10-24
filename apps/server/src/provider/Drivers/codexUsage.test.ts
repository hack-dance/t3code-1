import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";

import {
  CodexScanState,
  codexUsageFormat,
  initialCodexScanState,
  parseCodexLine,
} from "./codexUsage.ts";

const encodeCodexState = Schema.encodeSync(CodexScanState);
const decodeCodexState = Schema.decodeUnknownSync(CodexScanState);

describe("parseCodexLine", () => {
  const sessionMeta = JSON.stringify({
    type: "session_meta",
    timestamp: "2026-08-01T05:17:41.289Z",
    payload: { type: "session_meta", id: "019fbbc1-b12c-7360-a685-28c181f0025f" },
  });
  const turnContext = JSON.stringify({
    type: "turn_context",
    timestamp: "2026-08-01T05:17:42.694Z",
    payload: { type: "turn_context", model: "gpt-5.6-sol" },
  });
  const tokenCount = (inputTokens: number, cached: number, output: number, reasoning: number) =>
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-01T05:17:49.919Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: inputTokens,
            cached_input_tokens: cached,
            cache_write_input_tokens: 0,
            output_tokens: output,
            reasoning_output_tokens: reasoning,
          },
        },
      },
    });
  const counters = (input: number, output: number) => ({
    input_tokens: input,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  });
  const counted = (last: unknown, total?: unknown, extra = {}) =>
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-01T05:17:49.919Z",
      payload: {
        type: "token_count",
        info: { last_token_usage: last, total_token_usage: total, ...extra },
      },
    });

  it("bills response IDs once, ignores paired counts, and restores dedupe state from JSON", () => {
    let state = initialCodexScanState();
    parseCodexLine(sessionMeta, state);
    parseCodexLine(turnContext, state);
    const request = counters(100, 20);
    const modern = (response_id: string) =>
      JSON.stringify({
        timestamp: "2026-08-01T05:17:49.919Z",
        ordinal: 1,
        type: "token_usage_record",
        payload: {
          response_id,
          session_id: "session",
          turn_id: "turn",
          usage: request,
          turn_token_usage: request,
          thread_token_usage: request,
        },
      });
    expect(parseCodexLine(modern("response-1"), state)?.totals.outputTokens).toBe(20);
    expect(parseCodexLine(counted(request, request), state)).toBeNull();
    const encoded = JSON.parse(JSON.stringify(encodeCodexState(state)));
    state = decodeCodexState(encoded);
    expect(parseCodexLine(modern("response-1"), state)).toBeNull();
    expect(parseCodexLine(modern("response-2"), state)?.totals.outputTokens).toBe(20);
    expect(parseCodexLine(counted(request, counters(200, 40)), state)).toBeNull();
  });

  it("does not fall back to count billing after a malformed identified record", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    expect(
      parseCodexLine(
        JSON.stringify({ type: "token_usage_record", payload: { usage: null } }),
        state,
      ),
    ).toBeNull();
    expect(parseCodexLine(counted(counters(100, 20)), state)).toBeNull();
  });

  it("keeps unrelated legacy counts after an identified request and its mirror", () => {
    let state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    const modern = JSON.stringify({
      type: "token_usage_record",
      timestamp: "2026-08-01T05:17:49.919Z",
      payload: { response_id: "modern", usage: counters(100, 20) },
    });
    expect(parseCodexLine(counted(counters(10, 2), counters(10, 2)), state)).not.toBeNull();
    expect(parseCodexLine(modern, state)).not.toBeNull();
    state = decodeCodexState(JSON.parse(JSON.stringify(encodeCodexState(state))));
    expect(parseCodexLine(counted(counters(100, 20), counters(110, 22)), state)).toBeNull();
    expect(
      parseCodexLine(counted(counters(30, 3), counters(140, 25)), state)?.totals.outputTokens,
    ).toBe(3);
    expect(parseCodexLine(modern, state)).toBeNull();
    expect(
      parseCodexLine(counted(counters(40, 4), counters(180, 29)), state)?.totals.outputTokens,
    ).toBe(4);
  });

  it("documents the expected drop of identical legacy requests without cumulative identity", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    const request = counters(100, 20);
    // Two real requests and one replay have identical evidence; prefer underbilling.
    expect(parseCodexLine(counted(request), state)?.totals.outputTokens).toBe(20);
    expect(parseCodexLine(counted(request), state)).toBeNull();
  });

  it("documents the expected drop when a restarted legacy request equals the billed snapshot", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    const request = counters(100, 20);
    // A fresh process can reset to these same counts, indistinguishable from a replay.
    expect(parseCodexLine(counted(request, request), state)?.totals.outputTokens).toBe(20);
    expect(parseCodexLine(counted(request, request), state)).toBeNull();
  });

  it("attributes usage to the model from the preceding turn context", () => {
    const state = initialCodexScanState();
    parseCodexLine(sessionMeta, state);
    parseCodexLine(turnContext, state);
    const record = parseCodexLine(tokenCount(19239, 11008, 299, 116), state);

    expect(record?.provider).toBe("codex");
    expect(record?.model).toBe("gpt-5.6-sol");
    expect(record?.sessionId).toBe("019fbbc1-b12c-7360-a685-28c181f0025f");
    expect(record?.totals.uncachedInputTokens).toBe(19239 - 11008);
    expect(record?.totals.cachedInputTokens).toBe(11008);
    expect(record?.totals.reasoningTokens).toBe(116);
  });

  it("accepts a first cumulative snapshot that includes earlier history", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    expect(
      parseCodexLine(counted(counters(10, 2), counters(110, 22)), state)?.totals.outputTokens,
    ).toBe(2);
  });

  it("accepts a valid request after unattributed cumulative history", () => {
    const state = initialCodexScanState();
    parseCodexLine(counted(counters(100, 20), counters(100, 20)), state);
    parseCodexLine(turnContext, state);
    expect(
      parseCodexLine(counted(counters(10, 2), counters(110, 22)), state)?.totals.outputTokens,
    ).toBe(2);
  });

  it.each(["invalid-request", "invalid-total", "inconsistent", "invalid-request-total"])(
    "does not rebill a cumulative request replayed as legacy after %s",
    (kind) => {
      const state = initialCodexScanState();
      parseCodexLine(turnContext, state);
      const request = counters(100, 20);
      parseCodexLine(counted(request, request), state);
      const last =
        kind === "invalid-request"
          ? null
          : kind === "invalid-request-total"
            ? { ...request, total_tokens: 121 }
            : request;
      const total = kind === "invalid-total" ? { input_tokens: "bad" } : counters(250, 50);
      expect(parseCodexLine(counted(last, total), state)).toBeNull();
      expect(parseCodexLine(counted(request), state)).toBeNull();
    },
  );

  it.each(["invalid-timestamp", "malformed-total"])(
    "does not rebill a cumulative re-emission after %s",
    (kind) => {
      const state = initialCodexScanState();
      parseCodexLine(turnContext, state);
      const request = counters(100, 20);
      const original = counted(request, request);
      expect(parseCodexLine(original, state)?.totals.outputTokens).toBe(20);
      const skipped =
        kind === "invalid-timestamp"
          ? original.replace("2026-08-01T05:17:49.919Z", "invalid")
          : counted(request, { input_tokens: "bad" });
      expect(parseCodexLine(skipped, state)).toBeNull();
      expect(parseCodexLine(original, state)).toBeNull();
      expect(
        parseCodexLine(counted(counters(10, 2), counters(110, 22)), state)?.totals.outputTokens,
      ).toBe(2);
    },
  );

  describe.each([
    ["cumulative", "cumulative"],
    ["legacy", "legacy"],
    ["cumulative", "legacy"],
    ["legacy", "cumulative"],
  ])("%s -> %s replay", (from, to) => {
    it.each([
      [
        "invalid-timestamp",
        counted(counters(10, 2)).replace("2026-08-01T05:17:49.919Z", "invalid"),
      ],
      ["invalid-request", counted(null, counters(110, 22))],
      ["invalid-total", counted(counters(10, 2), { input_tokens: "bad" })],
      ["invalid-request-total", counted({ ...counters(10, 2), total_tokens: 13 })],
      ["inconsistent", counted(counters(10, 2), counters(250, 50))],
    ])("does not rebill across %s", (_kind, skipped) => {
      const state = initialCodexScanState();
      parseCodexLine(turnContext, state);
      const request = counters(100, 20);
      const original = counted(request, from === "cumulative" ? request : undefined);
      const replay = counted(request, to === "cumulative" ? request : undefined);
      const outputs = [original, skipped, replay, counted(counters(30, 5)), counted(request)].map(
        (line) => parseCodexLine(line, state)?.totals.outputTokens ?? null,
      );
      expect(outputs).toEqual([20, null, null, 5, 20]);
    });
  });

  it.each(["invalid-timestamp", "malformed-total"])(
    "preserves legacy recovery identity and an unknown baseline across %s skips",
    (kind) => {
      const state = initialCodexScanState();
      parseCodexLine(turnContext, state);
      const skipped =
        kind === "invalid-timestamp"
          ? counted(counters(10, 2), counters(110, 22)).replace(
              "2026-08-01T05:17:49.919Z",
              "invalid",
            )
          : counted(counters(10, 2), { input_tokens: "bad" });
      const outputs = [
        counted(counters(100, 20), counters(100, 20)),
        skipped,
        counted(counters(30, 5)),
        skipped,
        counted(counters(30, 5), counters(140, 27)),
        counted(counters(10, 2), counters(150, 29)),
      ].map((line) => parseCodexLine(line, state)?.totals.outputTokens ?? null);
      expect(outputs).toEqual([20, null, 5, null, null, 2]);
    },
  );

  it("deduplicates short replay/skip sequences after legacy recovery without losing new deltas", () => {
    const request = counters(30, 5);
    const snapshot = counters(140, 27);
    const skipped = [
      counted(counters(10, 2)).replace("2026-08-01T05:17:49.919Z", "invalid"),
      counted(counters(10, 2), { input_tokens: "bad" }),
    ];
    const alphabet = [...skipped, counted(request), counted(request, snapshot)];
    const sequences = (length: number): string[][] =>
      length === 0
        ? [[]]
        : sequences(length - 1).flatMap((prefix) => alphabet.map((line) => [...prefix, line]));

    for (const initialCumulative of [false, true]) {
      for (const gap of skipped) {
        for (const suffix of sequences(4)) {
          const state = initialCodexScanState();
          parseCodexLine(turnContext, state);
          const first = counters(100, 20);
          const lines = [
            counted(first, initialCumulative ? first : undefined),
            gap,
            counted(request),
            ...suffix,
            counted(request, snapshot),
            counted(request, counters(170, 32)),
            counted(counters(10, 2)),
            counted(counters(10, 2), counters(180, 34)),
          ];
          expect(
            lines.map((line) => parseCodexLine(line, state)?.totals.outputTokens ?? null),
            JSON.stringify(lines),
          ).toEqual([20, null, 5, null, null, null, null, null, 5, 2, null]);
        }
      }
    }
  });

  it("bills equal requests when a skipped record supplies a valid cumulative baseline", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    const request = counters(30, 5);
    const outputs = [
      counted(request),
      counted(null, counters(40, 7)),
      counted(request, counters(70, 12)),
    ].map((line) => parseCodexLine(line, state)?.totals.outputTokens ?? null);
    expect(outputs).toEqual([5, null, 5]);
  });

  it("recovers after a malformed cumulative snapshot leaves a gap", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    parseCodexLine(counted(counters(100, 20), counters(100, 20)), state);
    parseCodexLine(counted(counters(10, 2), { input_tokens: "bad" }), state);
    expect(
      parseCodexLine(counted(counters(30, 5), counters(140, 27)), state)?.totals.outputTokens,
    ).toBe(5);
  });

  it("recovers after a skipped timestamp leaves a cumulative gap", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    parseCodexLine(counted(counters(100, 20), counters(100, 20)), state);
    parseCodexLine(
      counted(counters(10, 2), counters(110, 22)).replace("2026-08-01T05:17:49.919Z", "invalid"),
      state,
    );
    expect(
      parseCodexLine(counted(counters(30, 5), counters(140, 27)), state)?.totals.outputTokens,
    ).toBe(5);
  });

  it("resets the baseline at a legacy compaction marker", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    parseCodexLine(counted(counters(100, 20), counters(100, 20)), state);
    parseCodexLine(counted({ ...counters(0, 0), total_tokens: 500 }), state);
    expect(state.lastCumulativeUsage).toBeNull();
    expect(parseCodexLine(counted(counters(10, 2)), state)?.totals.outputTokens).toBe(2);
    expect(
      parseCodexLine(counted(counters(20, 3), counters(30, 5)), state)?.totals.outputTokens,
    ).toBe(3);
  });

  it("skips a repeated token_count so deltas are not double counted", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    const first = parseCodexLine(tokenCount(100, 0, 10, 0), state);
    const repeat = parseCodexLine(tokenCount(100, 0, 10, 0), state);

    expect(first).not.toBeNull();
    expect(repeat).toBeNull();
  });

  it("does not consume counters before the model and timestamp are valid", () => {
    const state = initialCodexScanState();
    expect(parseCodexLine(tokenCount(100, 0, 10, 0), state)).toBeNull();
    parseCodexLine(turnContext, state);
    expect(parseCodexLine(tokenCount(100, 0, 10, 0), state)).not.toBeNull();

    const cumulativeState = initialCodexScanState();
    const line = counted(counters(100, 20), counters(100, 20));
    expect(parseCodexLine(line, cumulativeState)).toBeNull();
    parseCodexLine(turnContext, cumulativeState);
    expect(
      parseCodexLine(line.replace("2026-08-01T05:17:49.919Z", "invalid"), cumulativeState),
    ).toBeNull();
    expect(parseCodexLine(line, cumulativeState)?.totals.outputTokens).toBe(20);
    expect(codexUsageFormat.readMalformedRecords?.(cumulativeState)).toBe(0);
  });

  it("ignores stale changed requests but counts equal requests when totals advance across contexts", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    const request = counters(100, 20);
    expect(parseCodexLine(counted(request, request), state)?.totals.outputTokens).toBe(20);
    expect(parseCodexLine(counted(counters(20, 5), request), state)).toBeNull();
    expect(
      parseCodexLine(
        counted({ ...counters(0, 0), total_tokens: 20330 }, request, {
          model_context_window: 258400,
        }),
        state,
      ),
    ).toBeNull();
    expect(parseCodexLine(counted(request, counters(200, 40)), state)?.totals.outputTokens).toBe(
      20,
    );

    for (const [index, tier] of ["priority", "ultrafast"].entries()) {
      parseCodexLine(
        JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-astra" } }),
        state,
      );
      parseCodexLine(
        JSON.stringify({
          type: "event_msg",
          payload: { type: "thread_settings_applied", thread_settings: { service_tier: tier } },
        }),
        state,
      );
      const record = parseCodexLine(
        counted(request, counters(100 * (index + 3), 20 * (index + 3))),
        state,
      );
      expect(record).toMatchObject({
        model: "gpt-6-astra",
        speed: tier === "priority" ? "fast" : "ultrafast",
        totals: { uncachedInputTokens: 100, outputTokens: 20 },
      });
    }
    expect(codexUsageFormat.readMalformedRecords?.(state)).toBe(0);
  });

  it.each([false, true])(
    "does not rebill legacy requests or drop the next cumulative delta (initial cumulative=%s)",
    (initialCumulative) => {
      const state = initialCodexScanState();
      parseCodexLine(turnContext, state);
      const first = counters(100, 20);
      expect(
        parseCodexLine(counted(first, initialCumulative ? first : undefined), state)?.totals
          .outputTokens,
      ).toBe(20);
      expect(parseCodexLine(counted(first), state)).toBeNull();
      expect(parseCodexLine(counted(counters(20, 5)), state)?.totals.outputTokens).toBe(5);
      expect(parseCodexLine(counted(counters(20, 5), counters(120, 25)), state)).toBeNull();
      expect(
        parseCodexLine(counted(counters(10, 2), counters(130, 27)), state)?.totals.outputTokens,
      ).toBe(2);
      expect(codexUsageFormat.readMalformedRecords?.(state)).toBe(0);
    },
  );

  it("checks every cumulative component and recovers using an inconsistent pair's valid baseline", () => {
    const request = {
      ...counters(100, 20),
      cached_input_tokens: 30,
      cache_write_input_tokens: 10,
      reasoning_output_tokens: 5,
    };
    const fields = Object.keys(request) as (keyof typeof request)[];
    for (const field of fields) {
      const state = initialCodexScanState();
      parseCodexLine(turnContext, state);
      expect(parseCodexLine(counted(request, request), state)?.totals).toEqual({
        uncachedInputTokens: 60,
        cachedInputTokens: 30,
        cacheCreationTokens: 10,
        outputTokens: 20,
        reasoningTokens: 5,
      });
      const total = { ...request };
      for (const key of fields) total[key] *= 2;
      total[field] += 1;
      if (field === "input_tokens" || field === "output_tokens") total.total_tokens += 1;
      expect(parseCodexLine(counted(request, total), state), field).toBeNull();
      expect(codexUsageFormat.readMalformedRecords?.(state), field).toBe(1);
      for (const key of fields) total[key] += request[key];
      expect(parseCodexLine(counted(request, total), state)?.totals.outputTokens, field).toBe(20);
      expect(codexUsageFormat.readMalformedRecords?.(state), field).toBe(1);
    }
  });

  it.each(["continuation", "fork", "subagent"])(
    "bills only the latest request when a %s has no initial counter baseline",
    (source) => {
      const state = initialCodexScanState();
      parseCodexLine(
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-08-01T05:17:41.000Z",
          payload: {
            id: "child",
            model_provider: "openai",
            ...(source === "fork" ? { forked_from_id: "parent" } : {}),
            ...(source === "subagent"
              ? { source: { subagent: { thread_spawn: { parent_thread_id: "parent" } } } }
              : { source: "vscode" }),
          },
        }),
        state,
      );
      parseCodexLine(turnContext, state);
      const request = {
        ...counters(100, 20),
        cached_input_tokens: 30,
        cache_write_input_tokens: 10,
        reasoning_output_tokens: 5,
      };
      const cumulative = {
        ...counters(500, 60),
        cached_input_tokens: 200,
        cache_write_input_tokens: 20,
        reasoning_output_tokens: 15,
      };
      const first = counted(request, cumulative);
      expect(parseCodexLine(first, state)).toMatchObject({
        sessionId: "child",
        totals: {
          uncachedInputTokens: 60,
          cachedInputTokens: 30,
          cacheCreationTokens: 10,
          outputTokens: 20,
          reasoningTokens: 5,
        },
      });
      expect(parseCodexLine(first, state)).toBeNull();
      expect(parseCodexLine(counted(counters(10, 2), cumulative), state)).toBeNull();
      expect(
        parseCodexLine(
          counted(counters(10, 2), {
            ...cumulative,
            input_tokens: 510,
            output_tokens: 62,
            total_tokens: 572,
          }),
          state,
        )?.totals.outputTokens,
      ).toBe(2);
      expect(codexUsageFormat.readMalformedRecords?.(state)).toBe(0);
    },
  );

  it.each([
    {
      ...counters(90, 40),
      cached_input_tokens: 60,
      cache_write_input_tokens: 20,
      reasoning_output_tokens: 10,
    },
    {
      ...counters(200, 10),
      cached_input_tokens: 60,
      cache_write_input_tokens: 20,
      reasoning_output_tokens: 5,
    },
    {
      ...counters(200, 40),
      cached_input_tokens: 20,
      cache_write_input_tokens: 20,
      reasoning_output_tokens: 10,
    },
    {
      ...counters(200, 40),
      cached_input_tokens: 60,
      cache_write_input_tokens: 5,
      reasoning_output_tokens: 10,
    },
    {
      ...counters(200, 40),
      cached_input_tokens: 60,
      cache_write_input_tokens: 20,
      reasoning_output_tokens: 3,
    },
    {
      ...counters(110, 40),
      cached_input_tokens: 60,
      cache_write_input_tokens: 20,
      reasoning_output_tokens: 10,
    },
    {
      ...counters(200, 30),
      cached_input_tokens: 60,
      cache_write_input_tokens: 20,
      reasoning_output_tokens: 20,
    },
  ])("rejects an initial snapshot with an impossible inherited baseline: %j", (cumulative) => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    const request = {
      ...counters(100, 20),
      cached_input_tokens: 30,
      cache_write_input_tokens: 10,
      reasoning_output_tokens: 5,
    };
    expect(parseCodexLine(counted(request, cumulative), state)).toBeNull();
    expect(codexUsageFormat.readMalformedRecords?.(state)).toBe(1);
    expect(state.lastCumulativeUsage).toEqual(cumulative);
  });

  it.each(["request", "cumulative"])("skips malformed %s counters and recovers", (malformed) => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    const request = counters(100, 20);
    parseCodexLine(counted(request, request), state);
    expect(
      parseCodexLine(
        counted(
          malformed === "request" ? { ...request, cached_input_tokens: -1 } : request,
          malformed === "cumulative"
            ? { ...counters(200, 40), output_tokens: "40" }
            : counters(200, 40),
        ),
        state,
      ),
    ).toBeNull();
    expect(codexUsageFormat.readMalformedRecords?.(state)).toBe(1);
    expect(
      parseCodexLine(
        counted(request, malformed === "request" ? counters(300, 60) : counters(200, 40)),
        state,
      )?.totals.outputTokens,
    ).toBe(20);
    expect(codexUsageFormat.readMalformedRecords?.(state)).toBe(1);
  });

  it("does not bill a context-window estimate or lose the following real request", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    parseCodexLine(counted(counters(100, 20), counters(100, 20)), state);
    const estimate = { ...counters(0, 0), total_tokens: 1000 };
    expect(
      parseCodexLine(
        counted({ ...estimate, total_tokens: 880 }, estimate, { model_context_window: 1000 }),
        state,
      ),
    ).toBeNull();
    expect(
      parseCodexLine(counted(counters(10, 2), { ...counters(10, 2), total_tokens: 1012 }), state)
        ?.totals.outputTokens,
    ).toBe(2);
    expect(codexUsageFormat.readMalformedRecords?.(state)).toBe(0);
  });

  it.each([false, true])(
    "accepts the post-compaction context marker without a malformed record (prior request: %s)",
    (priorRequest) => {
      const state = initialCodexScanState();
      parseCodexLine(turnContext, state);
      if (priorRequest) parseCodexLine(counted(counters(100, 20), counters(100, 20)), state);
      const marker = counted({ ...counters(0, 0), total_tokens: 26387 }, counters(0, 0), {
        model_context_window: 475000,
      });
      expect(parseCodexLine(marker, state)).toBeNull();
      expect(
        parseCodexLine(counted(counters(30, 5), counters(30, 5)), state)?.totals.outputTokens,
      ).toBe(5);
      expect(codexUsageFormat.readMalformedRecords?.(state)).toBe(0);
    },
  );

  it("bills the first request after a resume restarts the cumulative counters", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    parseCodexLine(counted(counters(100, 20), counters(100, 20)), state);
    expect(
      parseCodexLine(counted(counters(30, 5), counters(30, 5)), state)?.totals.outputTokens,
    ).toBe(5);
    expect(
      parseCodexLine(counted(counters(10, 2), counters(40, 7)), state)?.totals.outputTokens,
    ).toBe(2);
    expect(codexUsageFormat.readMalformedRecords?.(state)).toBe(0);
  });

  it("retains initial tier evidence only for the own OpenAI session and exact context until native settings arrive", () => {
    const meta = (id: string, model_provider?: string) =>
      JSON.stringify({ type: "session_meta", payload: { id, model_provider } });
    const context = (turn_id?: string, model?: string) =>
      JSON.stringify({ type: "turn_context", payload: { turn_id, model } });
    for (const provider of ["openai", "t3", "custom", undefined]) {
      const state = initialCodexScanState();
      parseCodexLine(meta("own-session", provider), state);
      parseCodexLine(meta("ancestor", provider === "openai" ? "custom" : "openai"), state);
      parseCodexLine(context("first-turn", "gpt-6-astra"), state);
      const first = parseCodexLine(tokenCount(100, 0, 1, 0), state);
      expect(first).toMatchObject({
        sessionId: "own-session",
        model: "gpt-6-astra",
        speed: "standard",
      });
      if (provider === "openai") {
        expect(first).toHaveProperty("unresolvedServiceTierTurnId", "first-turn");
      } else {
        expect(first).not.toHaveProperty("unresolvedServiceTierTurnId");
      }

      parseCodexLine(context(undefined, "gpt-6-astra"), state);
      expect(parseCodexLine(tokenCount(100, 0, 2, 0), state)).not.toHaveProperty(
        "unresolvedServiceTierTurnId",
      );
      parseCodexLine(context("missing-model"), state);
      expect(parseCodexLine(tokenCount(100, 0, 3, 0), state)).not.toHaveProperty(
        "unresolvedServiceTierTurnId",
      );
      parseCodexLine(context("next-turn", "gpt-6-astra"), state);
      const next = parseCodexLine(tokenCount(100, 0, 4, 0), state);
      if (provider === "openai") {
        expect(next).toHaveProperty("unresolvedServiceTierTurnId", "next-turn");
      } else {
        expect(next).not.toHaveProperty("unresolvedServiceTierTurnId");
      }
    }

    for (const service_tier of ["standard", "", undefined, "priority", "ultrafast"]) {
      const state = initialCodexScanState();
      parseCodexLine(meta("own-session", "openai"), state);
      parseCodexLine(context("first-turn", "gpt-6-astra"), state);
      expect(parseCodexLine(tokenCount(100, 0, 1, 0), state)).toHaveProperty(
        "unresolvedServiceTierTurnId",
        "first-turn",
      );
      parseCodexLine(
        JSON.stringify({
          type: "event_msg",
          payload: { type: "thread_settings_applied", thread_settings: { service_tier } },
        }),
        state,
      );
      for (const output of [2, 3]) {
        parseCodexLine(context(`native-turn-${output}`, "gpt-6-astra"), state);
        const record = parseCodexLine(tokenCount(100, 0, output, 0), state);
        expect(record?.speed).toBe(
          service_tier === "priority"
            ? "fast"
            : service_tier === "ultrafast"
              ? "ultrafast"
              : "standard",
        );
        expect(record).not.toHaveProperty("unresolvedServiceTierTurnId");
      }
    }
  });

  // A forked/subagent rollout opens with the parent's history copied in and
  // every line re-stamped to the fork instant, then the ancestors' session
  // metas. Counting those again multiplied usage ~1.85x on real data (#5758).
  describe("forked rollouts", () => {
    const meta = (overrides: {
      id: string;
      timestamp: string;
      forkedFromId?: string;
      spawnParentId?: string;
    }) =>
      JSON.stringify({
        type: "session_meta",
        timestamp: overrides.timestamp,
        payload: {
          type: "session_meta",
          id: overrides.id,
          ...(overrides.forkedFromId === undefined
            ? {}
            : { forked_from_id: overrides.forkedFromId }),
          ...(overrides.spawnParentId === undefined
            ? {}
            : {
                source: {
                  subagent: { thread_spawn: { parent_thread_id: overrides.spawnParentId } },
                },
              }),
        },
      });
    const stamped = (timestamp: string, line: string) => {
      const parsed = JSON.parse(line) as { timestamp: string };
      parsed.timestamp = timestamp;
      return JSON.stringify(parsed);
    };

    it("drops the re-stamped copied burst and keeps the first real event", () => {
      const state = initialCodexScanState();
      const forkInstant = "2026-08-01T05:00:00.000Z";
      parseCodexLine(meta({ id: "child", timestamp: forkInstant, forkedFromId: "parent" }), state);
      parseCodexLine(meta({ id: "parent", timestamp: forkInstant }), state);
      parseCodexLine(stamped(forkInstant, turnContext), state);

      expect(
        parseCodexLine(
          stamped("2026-08-01T05:00:00.001Z", counted(counters(100, 10), counters(100, 10))),
          state,
        ),
      ).toBeNull();
      expect(
        parseCodexLine(
          stamped("2026-08-01T05:00:00.002Z", counted(counters(200, 20), counters(300, 30))),
          state,
        ),
      ).toBeNull();

      const real = parseCodexLine(
        stamped("2026-08-01T05:00:06.000Z", counted(counters(200, 20), counters(500, 50))),
        state,
      );
      expect(real).not.toBeNull();
      expect(real?.sessionId).toBe("child");
      expect(real?.totals.outputTokens).toBe(20);

      const next = parseCodexLine(
        stamped("2026-08-01T05:00:06.100Z", counted(counters(400, 40), counters(900, 90))),
        state,
      );
      expect(next).not.toBeNull();
      expect(codexUsageFormat.readMalformedRecords?.(state)).toBe(0);
    });

    it("recognizes subagent spawns without forked_from_id", () => {
      const state = initialCodexScanState();
      const spawnInstant = "2026-08-01T05:00:00.000Z";
      parseCodexLine(
        meta({ id: "child", timestamp: spawnInstant, spawnParentId: "parent" }),
        state,
      );
      parseCodexLine(stamped(spawnInstant, turnContext), state);
      expect(
        parseCodexLine(stamped("2026-08-01T05:00:00.001Z", tokenCount(100, 0, 10, 0)), state),
      ).toBeNull();
    });

    it("does not suppress anything in a rollout that is not a fork", () => {
      const state = initialCodexScanState();
      parseCodexLine(meta({ id: "root", timestamp: "2026-08-01T05:00:00.000Z" }), state);
      parseCodexLine(stamped("2026-08-01T05:00:00.100Z", turnContext), state);
      const record = parseCodexLine(
        stamped("2026-08-01T05:00:00.200Z", tokenCount(100, 0, 10, 0)),
        state,
      );
      expect(record).not.toBeNull();
    });
  });
});
