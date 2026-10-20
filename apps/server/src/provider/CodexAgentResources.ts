import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";
import type * as Schema from "effect/Schema";
import type * as CodexClient from "effect-codex-app-server/client";

import type { PreparedResources } from "./AgentResources.ts";

/** Apply filters after initialization, before any thread starts or resumes. */
export const configureCodexAgentResources = Effect.fn("AgentResources.configureCodex")(
  function* (input: {
    readonly client: Pick<CodexClient.CodexAppServerClient["Service"], "request">;
    readonly resources: PreparedResources;
    readonly cwd: string | null;
  }) {
    const { client, resources, cwd } = input;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* client.request("config/read", { cwd, includeLayers: false });
    const inherited = config.config.mcp_servers;
    const servers: Record<string, Schema.Json> = {};
    if (inherited !== null && typeof inherited === "object" && !Array.isArray(inherited)) {
      for (const [name, server] of Object.entries(inherited)) {
        if (server !== null && typeof server === "object" && !Array.isArray(server)) {
          servers[name] = { ...server, enabled: false };
        }
      }
    }
    Object.assign(servers, resources.codexMcpServers);
    // Individual roots keep selected skills below hidden containers such as .system discoverable.
    yield* client.request("skills/extraRoots/set", {
      extraRoots: Object.values(resources.skillPaths).map((file) => path.dirname(file)),
    });
    const listed = yield* client.request("skills/list", {
      ...(cwd === null ? {} : { cwds: [cwd] }),
      forceReload: true,
    });
    const skills: Array<{ path: string; enabled: boolean }> = [];
    for (const entry of listed.data) {
      for (const skill of entry.skills) {
        const canonical = yield* fs
          .realPath(skill.path)
          .pipe(Effect.orElseSucceed(() => undefined));
        const enabled = canonical !== undefined && resources.skillPaths[skill.name] === canonical;
        skills.push({ path: skill.path, enabled });
      }
    }
    // Thread overrides isolate each session without writing skill preferences to the user's home.
    return { mcp_servers: servers, "skills.config": skills };
  },
  Effect.provide(NodePath.layer),
);
