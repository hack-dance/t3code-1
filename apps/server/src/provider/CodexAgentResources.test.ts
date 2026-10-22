import { expect, it } from "@effect/vitest";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";

import { configureCodexAgentResources } from "./CodexAgentResources.ts";
import { makeCodexAppServerProtocolLogger } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";

it.effect("isolates MCP and canonical skill paths when unrelated skills have matching names", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entries: Array<CodexReplay.CodexAppServerReplayEntry> = [];
      const exchange = (method: string, params: unknown, result: unknown) => {
        const id = entries.length / 2 + 1;
        entries.push(
          { type: "expect_outbound", frame: { id, method, params } },
          { type: "emit_inbound", frame: { id, result } },
        );
      };
      exchange(
        "config/read",
        { cwd: "/workspace", includeLayers: false },
        {
          config: { mcp_servers: { inherited: { command: "other" }, docs: { command: "old" } } },
          origins: {},
        },
      );
      exchange("skills/extraRoots/set", { extraRoots: ["/workspace/source/review"] }, {});
      exchange(
        "skills/list",
        { cwds: ["/workspace"], forceReload: true },
        {
          data: [
            {
              cwd: "/workspace",
              errors: [],
              skills: [
                {
                  name: "review",
                  path: "/workspace/resources/review/SKILL.md",
                  enabled: false,
                  scope: "user",
                  description: "Review.",
                },
                {
                  name: "review",
                  path: "/workspace/.agents/skills/review/SKILL.md",
                  enabled: true,
                  scope: "repo",
                  description: "Other.",
                },
              ],
            },
          ],
        },
      );
      const driver = yield* CodexReplay.makeReplayDriver({
        provider: "codex",
        protocol: "codex.app-server",
        version: "fixture",
        scenario: "resources",
        entries,
      });
      const context = yield* Layer.build(CodexReplay.layerReplayWithDriver(driver));
      const client = Context.get(context, CodexClient.CodexAppServerClient);
      const config = yield* configureCodexAgentResources({
        client,
        cwd: "/workspace",
        resources: {
          homePath: "/workspace/instance",
          skillPaths: { review: "/workspace/source/review/SKILL.md" },
          skills: ["review"],
          mcpServerNames: ["docs"],
          claudeMcpServers: {},
          codexMcpServers: { docs: { command: "example-mcp", env: { CUSTOM: "synthetic-value" } } },
        },
      });
      expect(config).toEqual({
        "skills.config": [
          { path: "/workspace/resources/review/SKILL.md", enabled: true },
          { path: "/workspace/.agents/skills/review/SKILL.md", enabled: false },
        ],
        mcp_servers: {
          inherited: { command: "other", enabled: false },
          docs: { command: "example-mcp", env: { CUSTOM: "synthetic-value" } },
        },
      });
      expect(yield* Ref.get(driver.state)).toEqual({ cursor: entries.length, failure: null });
    }).pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          realPath: (path) =>
            Effect.succeed(
              path === "/workspace/resources/review/SKILL.md"
                ? "/workspace/source/review/SKILL.md"
                : path,
            ),
        }),
      ),
    ),
  ),
);

it.effect("redacts arbitrary env and header values in the existing Codex protocol logger", () =>
  Effect.gen(function* () {
    const events: Array<unknown> = [];
    const logger = makeCodexAppServerProtocolLogger({
      threadId: ThreadId.make("thread-resources"),
      providerSessionId: ProviderSessionId.make("session-resources"),
      nativeEventLogger: {
        filePath: "events.log",
        write: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        close: () => Effect.void,
      },
    })!;
    yield* logger({
      direction: "outgoing",
      stage: "decoded",
      payload: {
        method: "thread/start",
        params: {
          env: { CUSTOM: "synthetic-env-secret" },
          http_headers: { "X-Custom": "synthetic-header-secret" },
          config: {
            mcp_servers: {
              docs: {
                command: "example-mcp",
                args: ["--credential", "synthetic-argument-secret"],
                url: "https://example.com/mcp?key=synthetic-query-secret",
                env: { CUSTOM_VALUE: "synthetic-env-secret" },
                http_headers: { "X-Custom": "synthetic-header-secret" },
              },
            },
          },
        },
      },
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("synthetic-env-secret");
    expect(serialized).not.toContain("synthetic-header-secret");
    expect(serialized).not.toContain("synthetic-argument-secret");
    expect(serialized).not.toContain("synthetic-query-secret");
    expect(serialized).toContain("docs");
    expect(serialized).toContain("[REDACTED]");
  }),
);
