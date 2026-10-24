import { expect, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { loadConfig } from "./config.ts";

afterEach(() => vi.unstubAllEnvs());

it.effect("does not read any file when unconfigured", () =>
  Effect.gen(function* () {
    vi.stubEnv("T3CODE_RUN_EVENTS_CONFIG", undefined);
    const read = vi.fn(() => Effect.die("unexpected file access"));
    expect(
      yield* loadConfig().pipe(Effect.provide(FileSystem.layerNoop({ readFileString: read }))),
    ).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  }),
);

it.effect("loads an explicit file and disables malformed or unreadable configuration", () =>
  Effect.gen(function* () {
    vi.stubEnv("T3CODE_RUN_EVENTS_CONFIG", "/config/run-events.json");
    const read = vi.fn(() =>
      Effect.succeed('{"hostLabel":"host-a","command":{"executable":"hook"}}'),
    );
    expect(
      yield* loadConfig().pipe(Effect.provide(FileSystem.layerNoop({ readFileString: read }))),
    ).toEqual({ hostLabel: "host-a", command: { executable: "hook" } });
    expect(read).toHaveBeenCalledWith("/config/run-events.json");
    expect(
      yield* loadConfig().pipe(
        Effect.provide(
          FileSystem.layerNoop({ readFileString: () => Effect.succeed("invalid JSON") }),
        ),
      ),
    ).toBeUndefined();
    expect(yield* loadConfig().pipe(Effect.provide(FileSystem.layerNoop({})))).toBeUndefined();
  }),
);
