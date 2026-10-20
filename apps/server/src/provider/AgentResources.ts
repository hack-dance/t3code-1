import * as NodePath from "@effect/platform-node/NodePath";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

const Allowlist = Schema.Struct({
  skills: Schema.optional(Schema.Array(Schema.String)),
  mcpServers: Schema.optional(Schema.Array(Schema.String)),
});
const Source = Schema.Struct({
  skillsDirectory: Schema.optional(Schema.String),
  mcpConfigFile: Schema.optional(Schema.String),
  allowlist: Schema.optional(Allowlist),
});
const Configuration = Schema.Struct({
  codex: Schema.optional(Source),
  claude: Schema.optional(Source),
  instances: Schema.optional(Schema.Record(Schema.String, Allowlist)),
});
const decodeConfiguration = Schema.decodeUnknownEffect(Schema.fromJsonString(Configuration), {
  onExcessProperty: "error",
});
const ObjectSchema = Schema.Record(Schema.String, Schema.Unknown);
const decodeObject = Schema.decodeUnknownEffect(ObjectSchema);
const decodeJsonObject = Schema.decodeUnknownEffect(Schema.fromJsonString(ObjectSchema));
const decodeCodexServers = Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Json));
const StringMap = Schema.Record(Schema.String, Schema.String);
const ClaudeMcpServer = Schema.Union([
  Schema.StructWithRest(
    Schema.Struct({
      type: Schema.optionalKey(Schema.Literal("stdio")),
      command: Schema.String,
      args: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
      env: Schema.optionalKey(StringMap),
      cwd: Schema.optionalKey(Schema.String),
    }),
    [ObjectSchema],
  ),
  Schema.StructWithRest(
    Schema.Struct({
      type: Schema.Literals(["http", "sse"]),
      url: Schema.String,
      headers: Schema.optionalKey(StringMap),
    }),
    [ObjectSchema],
  ),
]);
const decodeClaudeServers = Schema.decodeUnknownEffect(
  Schema.Record(Schema.String, ClaudeMcpServer),
);

export class AgentResourcesError extends Schema.TaggedError<AgentResourcesError>()(
  "AgentResourcesError",
  { stage: Schema.Literals(["configuration", "source", "materialize"]), path: Schema.String },
) {
  override get message(): string {
    return `Could not prepare agent resources (${this.stage}): ${this.path}. Check the resource configuration and source files.`;
  }
}
const isAgentResourcesError = Schema.is(AgentResourcesError);

export interface PreparedResources {
  readonly homePath: string;
  readonly skills: ReadonlyArray<string>;
  readonly skillPaths: Readonly<Record<string, string>>;
  readonly mcpServerNames: ReadonlyArray<string>;
  readonly codexMcpServers: Readonly<Record<string, Schema.Json>>;
  readonly claudeMcpServers: Effect.Success<ReturnType<typeof decodeClaudeServers>>;
}

export class AgentResources extends Context.Service<
  AgentResources,
  {
    readonly prepare: (input: {
      readonly provider: "codex" | "claude";
      readonly instanceId: string;
      readonly homePath: string;
      readonly environment: NodeJS.ProcessEnv;
      readonly directory: string;
    }) => Effect.Effect<PreparedResources | undefined, AgentResourcesError, Scope.Scope>;
  }
>()("t3/provider/AgentResources") {}

function selectEntries<T>(
  entries: Readonly<Record<string, T>>,
  allowed: ReadonlyArray<string> | undefined,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(entries).filter(([name]) => allowed === undefined || allowed.includes(name)),
  );
}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;

  const readOptional = (file: string) =>
    fs
      .readFileString(file)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)));
  const readObject = Effect.fn("AgentResources.readObject")(function* (
    file: string,
    format: "json" | "toml",
    optional: boolean,
  ) {
    const contents = yield* (optional ? readOptional(file) : fs.readFileString(file)).pipe(
      Effect.mapError(() => new AgentResourcesError({ stage: "source", path: file })),
    );
    if (contents === undefined) return {};
    // Sanitize before this span ends: parser diagnostics can contain credentials.
    return yield* (
      format === "toml"
        ? Effect.try(() => parseToml(contents)).pipe(Effect.flatMap(decodeObject))
        : decodeJsonObject(contents)
    ).pipe(Effect.mapError(() => new AgentResourcesError({ stage: "source", path: file })));
  });
  const resolvePath = (value: string, base: string) =>
    path.resolve(base, expandHomePath(value, home));

  const discoverSkills = Effect.fn("AgentResources.discoverSkills")(function* (
    directory: string,
    optional: boolean,
    provider: "codex" | "claude",
    allowed: ReadonlyArray<string> | undefined,
  ) {
    const skills: Record<string, string> = {};
    const visited = new Set<string>();
    const visit = Effect.fn("AgentResources.visitSkills")(function* (
      root: string,
    ): Effect.fn.Return<void, PlatformError.PlatformError | AgentResourcesError> {
      const real = yield* fs.realPath(root);
      if (visited.has(real)) return;
      visited.add(real);
      const file = path.join(root, "SKILL.md");
      const contents = yield* readOptional(file);
      if (contents !== undefined) {
        let name = path.basename(root).trim();
        if (provider === "codex") {
          const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(contents);
          const metadata = match
            ? yield* Effect.try(() => parseYaml(match[1]!, { logLevel: "error" })).pipe(
                Effect.flatMap(decodeObject),
                // Invalid frontmatter has no usable declared identity. Only a selected
                // folder (or unrestricted discovery) should make it a source failure.
                Effect.catch(() =>
                  allowed !== undefined && !allowed.includes(name)
                    ? Effect.succeed(undefined)
                    : Effect.fail(new AgentResourcesError({ stage: "source", path: file })),
                ),
              )
            : {};
          if (metadata === undefined) return;
          if (typeof metadata.name === "string" && metadata.name.trim())
            name = metadata.name.trim();
        }
        if (allowed !== undefined && !allowed.includes(name)) return;
        if (Object.hasOwn(skills, name)) {
          return yield* new AgentResourcesError({ stage: "source", path: file });
        }
        skills[name] = root;
        return;
      }
      for (const name of (yield* fs.readDirectory(root)).toSorted()) {
        const child = path.join(root, name);
        if ((yield* fs.stat(child)).type === "Directory") yield* visit(child);
      }
    });
    if (!optional || (yield* fs.exists(directory))) yield* visit(directory);
    return skills;
  });

  const prepare: AgentResources["Service"]["prepare"] = Effect.fn("AgentResources.prepare")(
    function* (input) {
      const configPath = input.environment.T3CODE_AGENT_RESOURCES_FILE?.trim();
      if (!configPath) return undefined;
      const file = resolvePath(configPath, home);
      const config = yield* fs.readFileString(file).pipe(
        Effect.flatMap(decodeConfiguration),
        // Parser failures can include source lines containing credentials.
        Effect.mapError(() => new AgentResourcesError({ stage: "configuration", path: file })),
      );
      const source = config[input.provider];
      if (source === undefined) return undefined;
      const defaults = path.join(home, input.provider === "codex" ? ".codex" : ".claude");
      const skillsDirectory =
        source.skillsDirectory === undefined
          ? path.join(defaults, "skills")
          : resolvePath(source.skillsDirectory, path.dirname(file));
      const allowlist = { ...source.allowlist, ...config.instances?.[input.instanceId] };
      const resolved = yield* Effect.gen(function* () {
        const skills = yield* discoverSkills(
          skillsDirectory,
          source.skillsDirectory === undefined,
          input.provider,
          allowlist.skills,
        );
        let servers: Record<string, unknown> = {};
        const sourcePaths =
          source.mcpConfigFile !== undefined
            ? [resolvePath(source.mcpConfigFile, path.dirname(file))]
            : input.provider === "codex"
              ? [path.join(defaults, "config.toml")]
              : [
                  path.join(defaults, "settings.json"),
                  path.join(defaults, ".mcp.json"),
                  path.join(home, ".claude.json"),
                ];
        for (const sourcePath of sourcePaths) {
          const document = yield* readObject(
            sourcePath,
            input.provider === "codex" ? "toml" : "json",
            source.mcpConfigFile === undefined,
          );
          const entries = document[input.provider === "codex" ? "mcp_servers" : "mcpServers"];
          if (entries !== undefined) {
            const parsed = yield* decodeObject(entries).pipe(
              Effect.tap((object) =>
                input.provider === "claude"
                  ? decodeClaudeServers(object).pipe(Effect.asVoid)
                  : decodeCodexServers(object).pipe(Effect.asVoid),
              ),
              Effect.mapError(() => new AgentResourcesError({ stage: "source", path: sourcePath })),
            );
            Object.assign(servers, parsed);
          }
        }
        servers = selectEntries(servers, allowlist.mcpServers);
        const claudeMcpServers =
          input.provider === "claude" ? yield* decodeClaudeServers(servers) : {};
        const codexMcpServers = yield* decodeCodexServers(servers);
        return { skills, servers, claudeMcpServers, codexMcpServers };
      }).pipe(
        Effect.mapError((error) =>
          isAgentResourcesError(error)
            ? error
            : new AgentResourcesError({ stage: "source", path: skillsDirectory }),
        ),
      );

      return yield* Effect.gen(function* () {
        const baseHome = resolvePath(
          input.homePath ||
            input.environment[input.provider === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"] ||
            defaults,
          home,
        );
        const skillPaths = Object.fromEntries(
          yield* Effect.forEach(Object.entries(resolved.skills), ([name, directory]) =>
            fs
              .realPath(path.join(directory, "SKILL.md"))
              .pipe(Effect.map((file) => [name, file] as const)),
          ),
        );
        let resourceHome = baseHome;
        if (input.provider === "codex") {
          yield* fs.makeDirectory(baseHome, { recursive: true, mode: 0o700 });
        } else {
          const directory = path.join(input.directory, "agent-resources");
          yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
          const overlay = yield* fs.makeTempDirectoryScoped({ directory, prefix: "claude-" });
          yield* fs.chmod(overlay, 0o700);
          resourceHome = path.join(overlay, ".claude");
          yield* fs.makeDirectory(path.join(resourceHome, "skills"), { recursive: true });
          // Claude discovers direct child folders; expose nested selections by the same name.
          for (const [name, skill] of Object.entries(resolved.skills)) {
            yield* fs.symlink(skill, path.join(resourceHome, "skills", name));
          }
        }
        return {
          homePath: resourceHome,
          skillPaths,
          skills: Object.keys(resolved.skills).toSorted(),
          mcpServerNames: Object.keys(resolved.servers).toSorted(),
          claudeMcpServers: resolved.claudeMcpServers,
          codexMcpServers: resolved.codexMcpServers,
        };
      }).pipe(
        Effect.mapError(
          () => new AgentResourcesError({ stage: "materialize", path: input.directory }),
        ),
      );
    },
  );
  return AgentResources.of({ prepare });
});

export const layer = Layer.effect(AgentResources, make).pipe(Layer.provide(NodePath.layer));
