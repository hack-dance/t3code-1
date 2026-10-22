import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Tracer from "effect/Tracer";
import { vi } from "vite-plus/test";
import { parse as parseToml } from "smol-toml";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as AgentResources from "./AgentResources.ts";

const CODEX_CONFIG = `
model = "example-model"
[mcp_servers.docs]
command = "example-mcp"
args = ["--read-only"]
[mcp_servers.docs.env]
EXAMPLE_VALUE = "synthetic-env-value"
[mcp_servers.remote]
url = "https://example.com/mcp"
[mcp_servers.remote.http_headers]
X-Custom = "synthetic-header-value"
`;
const CLAUDE_CONFIG = {
  mcpServers: {
    docs: { command: "example-mcp", args: ["--read-only"] },
    remote: {
      type: "http",
      url: "https://example.com/mcp",
      headers: { "X-Custom": "synthetic-header-value" },
      timeout: 12000,
    },
  },
};

const fixture = Effect.fn("AgentResources.test.fixture")(function* (config: unknown) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agent-resources-" });
  const home = path.join(root, "home");
  const instance = path.join(root, "instance");
  const file = path.join(root, "resources.json");
  const write = (name: string, content: string) =>
    fs
      .makeDirectory(path.dirname(name), { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(name, content)));
  for (const provider of [".codex", ".claude"]) {
    yield* write(
      path.join(home, provider, "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: Review a change.\n---\nReview it.\n",
    );
    yield* write(
      path.join(home, provider, "skills", ".system", "explain", "SKILL.md"),
      "---\nname: explain\ndescription: Explain a change.\n---\nExplain it.\n",
    );
    yield* write(
      path.join(home, provider, "skills", "review", "scripts", "example.txt"),
      "support",
    );
  }
  yield* write(path.join(home, ".codex", "config.toml"), CODEX_CONFIG);
  yield* write(path.join(home, ".claude.json"), JSON.stringify(CLAUDE_CONFIG));
  yield* write(path.join(instance, "config.toml"), '[mcp_servers.unrelated]\ncommand = "other"\n');
  yield* write(path.join(instance, "auth.json"), '{"example":"synthetic-auth"}');
  yield* write(path.join(instance, "skills", "unrelated", "SKILL.md"), "unrelated");
  yield* write(file, JSON.stringify(config));
  const service = yield* AgentResources.AgentResources.pipe(
    Effect.provide(AgentResources.layer),
    Effect.provideService(HostProcess.HomeDirectory, home),
  );
  const input = {
    provider: "codex" as const,
    instanceId: "instance-a",
    homePath: instance,
    environment: { T3CODE_AGENT_RESOURCES_FILE: file },
    directory: path.join(root, "overlays"),
  };
  return { fs, path, root, home, instance, file, write, service, input };
});

it.layer(NodeServices.layer)("AgentResources", (it) => {
  it.effect("does no filesystem work when unconfigured", () =>
    Effect.gen(function* () {
      const f = yield* fixture({});
      yield* f.fs.remove(f.file);
      expect(yield* f.service.prepare({ ...f.input, environment: {} })).toBeUndefined();
      expect(yield* f.fs.exists(f.input.directory)).toBe(false);
    }),
  );

  it.effect("leaves providers without a source unconfigured", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ claude: {} });
      expect(yield* f.service.prepare(f.input)).toBeUndefined();
    }),
  );

  it.effect("matches the skills and MCP servers parsed from a fixture default Codex home", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ codex: {} });
      const resources = (yield* f.service.prepare(f.input))!;
      const native = parseToml(
        yield* f.fs.readFileString(f.path.join(f.home, ".codex", "config.toml")),
      );
      expect(resources.mcpServerNames).toEqual(Object.keys(native.mcp_servers!).sort());
      const sourceSkills = [
        f.path.join(f.home, ".codex", "skills", "review", "SKILL.md"),
        f.path.join(f.home, ".codex", "skills", ".system", "explain", "SKILL.md"),
      ];
      const names = yield* Effect.forEach(sourceSkills, (file) =>
        f.fs.readFileString(file).pipe(Effect.map((text) => /^name: (.+)$/m.exec(text)![1])),
      );
      expect(resources.skills).toEqual(names.sort());
      expect(resources.codexMcpServers).toEqual(native.mcp_servers);
      expect(resources.homePath).toBe(f.instance);
      expect(
        yield* f.fs.readFileString(
          f.path.join(f.path.dirname(resources.skillPaths.review!), "scripts", "example.txt"),
        ),
      ).toBe("support");
      expect(resources.skillPaths.review).toBe(yield* f.fs.realPath(sourceSkills[0]!));
      expect(yield* f.fs.readFileString(f.path.join(f.instance, "config.toml"))).toContain(
        "unrelated",
      );
      expect(yield* f.fs.readFileString(f.path.join(f.home, ".codex", "config.toml"))).toBe(
        CODEX_CONFIG,
      );
    }),
  );

  it.effect("overrides provider allowlists per instance, including empty lists", () =>
    Effect.gen(function* () {
      const f = yield* fixture({
        codex: { allowlist: { skills: ["review"], mcpServers: ["docs"] } },
        instances: { "instance-a": { skills: [], mcpServers: ["remote"] } },
      });
      const resources = (yield* f.service.prepare(f.input))!;
      expect(resources.skills).toEqual([]);
      expect(resources.mcpServerNames).toEqual(["remote"]);
      expect(resources.skillPaths).toEqual({});
      const other = (yield* f.service.prepare({ ...f.input, instanceId: "instance-b" }))!;
      expect(other.skills).toEqual(["review"]);
      expect(other.mcpServerNames).toEqual(["docs"]);
      expect(Object.keys(other.skillPaths)).toEqual(["review"]);
    }),
  );

  it.effect(
    "loads Claude default settings, MCP file and user config with explicit precedence",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ claude: {} });
        yield* f.write(
          f.path.join(f.home, ".claude", "settings.json"),
          JSON.stringify({
            mcpServers: { settings: { command: "settings-server" }, docs: { command: "old" } },
          }),
        );
        yield* f.write(
          f.path.join(f.home, ".claude", ".mcp.json"),
          JSON.stringify({
            mcpServers: { local: { command: "local-server" } },
          }),
        );
        const resources = (yield* f.service.prepare({ ...f.input, provider: "claude" }))!;
        expect(resources.skills).toEqual(["explain", "review"]);
        expect(resources.mcpServerNames).toEqual(["docs", "local", "remote", "settings"]);
        expect(resources.claudeMcpServers.docs).toEqual(CLAUDE_CONFIG.mcpServers.docs);
        expect(resources.claudeMcpServers.remote).toEqual(CLAUDE_CONFIG.mcpServers.remote);
      }),
  );

  it.effect("resolves explicit sources relative to the configuration file and expands tilde", () =>
    Effect.gen(function* () {
      const f = yield* fixture({
        claude: {
          skillsDirectory: "~/.codex/skills",
          mcpConfigFile: "selected.json",
          allowlist: {
            skills: ["review"],
            mcpServers: ["remote", "missing"],
          },
        },
      });
      yield* f.write(f.path.join(f.root, "selected.json"), JSON.stringify(CLAUDE_CONFIG));
      const resources = (yield* f.service.prepare({ ...f.input, provider: "claude" }))!;
      expect(resources.skills).toEqual(["review"]);
      expect(resources.mcpServerNames).toEqual(["remote"]);
    }),
  );

  it.effect("reloads configuration for each session without changing existing selections", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ codex: {} });
      const first = (yield* f.service.prepare(f.input))!;
      yield* f.write(
        f.file,
        JSON.stringify({ codex: { allowlist: { skills: [], mcpServers: [] } } }),
      );
      const second = (yield* f.service.prepare(f.input))!;
      expect(second.skills).toEqual([]);
      expect(second.mcpServerNames).toEqual([]);
      expect(first.skills).toEqual(["explain", "review"]);
      expect(yield* f.fs.exists(first.skillPaths.review!)).toBe(true);
    }),
  );

  it.effect("retains newly created Codex runtime files when a session closes", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ codex: {} });
      yield* f.fs.remove(f.instance, { recursive: true });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const resources = (yield* f.service.prepare(f.input))!;
          yield* f.write(f.path.join(resources.homePath, "sessions", "example.jsonl"), "history");
          for (const file of [
            "auth.json",
            "history.jsonl",
            "log/runtime.log",
            "future-state/data",
          ]) {
            yield* f.write(f.path.join(resources.homePath, file), "durable");
          }
        }),
      );

      const reopened = (yield* f.service.prepare(f.input))!;
      for (const file of ["auth.json", "history.jsonl", "log/runtime.log", "future-state/data"]) {
        expect(yield* f.fs.readFileString(f.path.join(reopened.homePath, file))).toBe("durable");
      }
      expect(yield* f.fs.readFileString(f.path.join(f.instance, "sessions", "example.jsonl"))).toBe(
        "history",
      );
    }),
  );

  it.effect("removes Claude skill links when a session closes", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ claude: {} });
      const overlay = yield* Effect.scoped(
        f.service
          .prepare({ ...f.input, provider: "claude" })
          .pipe(Effect.map((resources) => resources!.homePath)),
      );
      expect(yield* f.fs.exists(overlay)).toBe(false);
      expect(
        yield* f.fs.exists(f.path.join(f.home, ".claude", "skills", "review", "SKILL.md")),
      ).toBe(true);
    }),
  );

  it.effect(
    "fails closed on missing explicit sources and malformed configs without exposing contents",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ codex: { mcpConfigFile: "missing.toml" } });
        expect(yield* Effect.flip(f.service.prepare(f.input))).toMatchObject({ stage: "source" });
        yield* f.write(f.file, '{"codex": synthetic-secret');
        const error = yield* Effect.flip(f.service.prepare(f.input));
        expect(error.stage).toBe("configuration");
        expect(JSON.stringify(error)).not.toContain("synthetic-secret");
        expect(String(error)).not.toContain("synthetic-secret");
        expect(yield* f.fs.exists(f.input.directory)).toBe(false);
      }),
  );

  it.effect("rejects misspelled allowlist keys", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ codex: { allowlist: { skill: ["review"] } } });
      expect(yield* Effect.flip(f.service.prepare(f.input))).toMatchObject({
        stage: "configuration",
      });
    }),
  );

  it.effect.each([
    {
      label: "configuration schema",
      file: "resources.json",
      contents: '{"codex": "synthetic-parser-credential"}',
      span: "prepare",
    },
    {
      label: "source TOML",
      file: "home/.codex/config.toml",
      contents: "[mcp_servers.docs]\ncommand = synthetic-parser-credential",
      span: "readObject",
    },
    {
      label: "source JSON",
      file: "home/.claude.json",
      contents: '{"mcpServers": synthetic-parser-credential}',
      span: "readObject",
      provider: "claude" as const,
    },
    {
      label: "skill YAML syntax",
      file: "home/.codex/skills/review/SKILL.md",
      contents: "---\nname: [synthetic-parser-credential\n---\n",
      span: "visitSkills",
    },
    {
      label: "skill YAML schema",
      file: "home/.codex/skills/review/SKILL.md",
      contents: "---\n- synthetic-parser-credential\n---\n",
      span: "visitSkills",
    },
  ])("sanitizes recorded trace failures for $label", (scenario) =>
    Effect.gen(function* () {
      const f = yield* fixture({ codex: {}, claude: {} });
      yield* f.write(f.path.join(f.root, scenario.file), scenario.contents);
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const exit = yield* f.service
        .prepare({
          ...f.input,
          provider: scenario.provider ?? "codex",
        })
        .pipe(Effect.withTracer(tracer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit))
        expect(Cause.pretty(exit.cause)).toContain(f.path.join(f.root, scenario.file));
      const failures = spans.flatMap((span) =>
        span.status._tag === "Ended" && Exit.isFailure(span.status.exit)
          ? [
              {
                name: span.name,
                cause: Cause.pretty(span.status.exit.cause),
                exit: span.status.exit,
                events: span.events,
              },
            ]
          : [],
      );
      expect(failures.map((failure) => failure.name)).toContain(`AgentResources.${scenario.span}`);
      expect(JSON.stringify(failures)).not.toContain("synthetic-parser-credential");
      expect(JSON.stringify(failures)).toContain("AgentResourcesError");
    }),
  );
  it.effect("suppresses YAML parser warnings containing source text", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ codex: {} });
      yield* f.write(
        f.path.join(f.home, ".codex", "skills", "review", "SKILL.md"),
        "---\nname: review\ndescription: !unknown synthetic-private-warning\n---\n",
      );
      const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const consoleWarning = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        yield* f.service.prepare(f.input);
        expect(warning).not.toHaveBeenCalled();
        expect(stderr).not.toHaveBeenCalled();
        expect(consoleWarning).not.toHaveBeenCalled();
      } finally {
        warning.mockRestore();
        stderr.mockRestore();
        consoleWarning.mockRestore();
      }
    }),
  );

  it.effect.each(["codex", "claude"] as const)(
    "ignores unselected invalid and duplicate %s skills",
    (provider) =>
      Effect.gen(function* () {
        const f = yield* fixture({ [provider]: { allowlist: { skills: ["review"] } } });
        const skills = f.path.join(f.home, "." + provider, "skills");
        yield* f.write(f.path.join(skills, "broken", "SKILL.md"), "---\nname: [invalid\n---\n");
        yield* f.write(
          f.path.join(skills, "nested", "explain", "SKILL.md"),
          "---\nname: explain\n---\n",
        );
        const resources = (yield* f.service.prepare({ ...f.input, provider }))!;
        expect(resources.skills).toEqual(["review"]);
        yield* f.write(
          f.path.join(skills, "nested", "review", "SKILL.md"),
          "---\nname: review\n---\n",
        );
        const error = yield* Effect.flip(f.service.prepare({ ...f.input, provider }));
        expect(error.path).toBe(f.path.join(skills, "review", "SKILL.md"));
      }),
  );
});
