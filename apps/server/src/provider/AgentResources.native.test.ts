import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as CodexClient from "effect-codex-app-server/client";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as AgentResources from "./AgentResources.ts";
import { configureCodexAgentResources } from "./CodexAgentResources.ts";

// Opt in with an installed app-server binary; CI's unit suite needs no provider installation.
const binary = process.env.T3CODE_TEST_CODEX_BINARY;

it.effect.skipIf(binary === undefined)(
  "reopens native Codex goal storage after closing a fresh resource session",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-resources-native-" });
      const home = path.join(root, "account");
      const instance = path.join(root, "instance");
      const cwd = path.join(root, "project");
      const source = path.join(root, "source");
      const collision = path.join(cwd, ".agents", "skills", "review");
      for (const directory of [
        home,
        path.join(cwd, ".git"),
        path.join(source, "review"),
        path.join(source, ".system", "explain"),
        collision,
      ]) {
        yield* fs.makeDirectory(directory, { recursive: true });
      }
      yield* fs.writeFileString(
        path.join(source, "review", "SKILL.md"),
        "---\nname: review\ndescription: Review a change.\n---\nReview it.\n",
      );
      yield* fs.writeFileString(
        path.join(collision, "SKILL.md"),
        "---\nname: review\ndescription: Unrelated project skill.\n---\nOther.\n",
      );
      yield* fs.writeFileString(
        path.join(source, ".system", "explain", "SKILL.md"),
        "---\nname: explain\ndescription: Explain a change.\n---\nExplain it.\n",
      );
      const file = path.join(root, "resources.json");
      yield* fs.writeFileString(
        file,
        JSON.stringify({
          codex: {
            skillsDirectory: source,
            allowlist: { skills: ["review", "explain"], mcpServers: [] },
          },
        }),
      );
      const service = yield* AgentResources.AgentResources.pipe(
        Effect.provide(AgentResources.layer),
        Effect.provideService(HostProcess.HomeDirectory, home),
      );
      const open = Effect.gen(function* () {
        const resources = (yield* service.prepare({
          provider: "codex",
          instanceId: "instance-a",
          homePath: instance,
          environment: { T3CODE_AGENT_RESOURCES_FILE: file },
          directory: root,
        }))!;
        const handle = yield* spawner.spawn(
          ChildProcess.make(binary!, ["app-server"], {
            cwd,
            env: {
              HOME: home,
              CODEX_HOME: resources.homePath,
              PATH: process.env.PATH ?? "",
              TMPDIR: root,
            },
            extendEnv: false,
          }),
        );
        const client = Context.get(
          yield* Layer.build(CodexClient.layerChildProcess(handle)),
          CodexClient.CodexAppServerClient,
        );
        yield* client.request("initialize", {
          clientInfo: { name: "resource-test", version: "0.0.0" },
          capabilities: { experimentalApi: true },
        });
        yield* client.notify("initialized", undefined);
        const config = yield* configureCodexAgentResources({ client, resources, cwd });
        expect(
          config["skills.config"]
            .filter((skill) => skill.enabled)
            .map((skill) => skill.path)
            .toSorted(),
        ).toEqual(Object.values(resources.skillPaths).toSorted());
        expect(resources.skills).toEqual(["explain", "review"]);
        expect(config["skills.config"]).toContainEqual({
          path: yield* fs.realPath(path.join(collision, "SKILL.md")),
          enabled: false,
        });
        return { client, config, resources };
      });
      const first = yield* Effect.scoped(
        Effect.gen(function* () {
          const { client, config } = yield* open;
          const started = yield* client.request("thread/start", {
            cwd,
            config: { ...config, "features.goals": true },
          });
          const saved = yield* client.request("thread/goal/set", {
            threadId: started.thread.id,
            objective: "Verify durable resource state",
          });
          return {
            threadId: started.thread.id,
            goal: saved.goal,
          };
        }),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* open;
          const restored = yield* client.request("thread/goal/get", { threadId: first.threadId });
          expect(restored.goal).toEqual(first.goal);
        }),
      );
      expect((yield* fs.readDirectory(instance)).some((name) => name.endsWith(".sqlite"))).toBe(
        true,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  30_000,
);
