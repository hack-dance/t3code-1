import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type Project as ProjectRecord,
  type ModelSelection,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerConfig from "../../../config.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ProjectHandlers from "./handlers.ts";
import { ProjectToolkit } from "./tools.ts";

const clientLaunchHarness = (input: {
  readonly runtimeModeCeiling: RuntimeMode;
  readonly defaultRuntimeMode?: RuntimeMode;
  /** Where Settings saves a project's model; the legacy project field stays null. */
  readonly overrideModel?: ModelSelection;
  readonly launched: Array<ThreadLaunch.ThreadLaunchInput>;
  readonly workspaceRoot?: string;
  readonly checkWorktreeBase?: ThreadLaunch.ThreadLaunchService["Service"]["checkWorktreeBase"];
}) => {
  const projectId = ProjectId.make("project:client-target");
  const modelSelection = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-opus",
  };
  const layerDependencies = Layer.mergeAll(
    ServerSettings.layerTest({
      ...(input.defaultRuntimeMode === undefined
        ? {}
        : { defaultRuntimeMode: input.defaultRuntimeMode }),
      ...(input.overrideModel === undefined
        ? {}
        : {
            projectSettingsFolded: true,
            projectSettingsOverrides: {
              [projectId]: { defaultModelSelection: input.overrideModel },
            },
          }),
    }),
    NodeCrypto.layer,
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: "client:session-1",
      thread: undefined,
      client: {
        sessionId: "session-1",
        label: "Claude Code",
        access: input.runtimeModeCeiling,
      },
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({}),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      checkWorktreeBase: input.checkWorktreeBase ?? (() => Effect.void),
      launch: (launch) => {
        input.launched.push(launch);
        return Effect.succeed({
          threadId: launch.threadId,
          projection: {
            thread: {
              id: launch.threadId,
              projectId: launch.projectId,
              modelSelection: launch.modelSelection,
            },
            runs: [],
          },
          resumed: false,
        } as unknown as ThreadLaunch.ThreadLaunchResult);
      },
    }),
    Layer.mock(Project.ProjectService)({
      getById: (id) =>
        Effect.succeed(
          id === projectId
            ? Option.some({
                id,
                workspaceRoot: input.workspaceRoot ?? "/projects/client-target",
                defaultModelSelection: input.overrideModel === undefined ? modelSelection : null,
              } as unknown as ProjectRecord)
            : Option.none(),
        ),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
    NodeServices.layer,
  ).pipe(
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-client-launch-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return { projectId, modelSelection, dependencies: layerDependencies };
};

it.effect(
  "a client launches with the project's default model and mode, capped at its ceiling",
  () =>
    Effect.gen(function* () {
      const launchWith = Effect.fn("test.launchWith")(function* (
        runtimeModeCeiling: RuntimeMode,
        defaultRuntimeMode: RuntimeMode,
        params: {
          readonly title: string;
          readonly message?: string;
          readonly runtimeMode?: RuntimeMode;
          readonly targeted?: false;
          readonly overrideModel?: ModelSelection;
        },
      ) {
        const { targeted, overrideModel, ...input } = params;
        const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
        const { projectId, modelSelection, dependencies } = clientLaunchHarness({
          runtimeModeCeiling,
          defaultRuntimeMode,
          launched,
          ...(overrideModel === undefined ? {} : { overrideModel }),
        });
        const toolkit = yield* ProjectToolkit.pipe(
          Effect.provide(
            McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
              Layer.provide(dependencies),
            ),
          ),
        );
        const result = yield* toolkit
          .handle("t3_thread_launch", targeted === false ? input : { ...input, projectId })
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
        return { result: result.at(-1)?.result, launched, projectId, modelSelection };
      });

      const belowCeiling = yield* launchWith("full-access", "approval-required", {
        title: "Fix",
        message: "Fix the bug",
      });
      expect(belowCeiling.result).toMatchObject({
        projectId: belowCeiling.projectId,
        modelSelection: belowCeiling.modelSelection,
      });
      expect(belowCeiling.launched[0]?.runtimeMode).toBe("approval-required");
      expect(belowCeiling.launched[0]?.initialMessage?.senderThreadId).toBeUndefined();

      const aboveCeiling = yield* launchWith("auto-accept-edits", "full-access", { title: "Fix" });
      expect(aboveCeiling.launched[0]?.runtimeMode).toBe("auto-accept-edits");

      const requested = yield* launchWith("full-access", "approval-required", {
        title: "Fix",
        runtimeMode: "auto",
      });
      expect(requested.launched[0]?.runtimeMode).toBe("auto");

      const escalated = yield* launchWith("auto-accept-edits", "auto-accept-edits", {
        title: "Fix",
        runtimeMode: "full-access",
      });
      expect(escalated.result).toMatchObject({ code: "runtime_mode_escalation_denied" });
      expect(escalated.launched).toHaveLength(0);

      const untargeted = yield* launchWith("full-access", "full-access", {
        title: "Fix",
        targeted: false,
      });
      expect(untargeted.result).toMatchObject({ code: "target_required" });

      const overrideModel = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-settings",
      };
      const fromSettings = yield* launchWith("full-access", "full-access", {
        title: "Fix",
        overrideModel,
      });
      expect(fromSettings.launched[0]?.modelSelection).toEqual(overrideModel);
    }),
);

it.effect("a launch binds only an existing checkout that is one of the project's worktrees", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-launch-worktree-" });
    const repo = path.join(root, "repo");
    const worktree = path.join(root, "feature");
    const outside = path.join(root, "outside");
    yield* fileSystem.makeDirectory(repo);
    yield* fileSystem.makeDirectory(outside);

    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
      workspaceRoot: repo,
    });
    const git = yield* GitVcsDriver.GitVcsDriver.pipe(Effect.provide(dependencies));
    for (const args of [
      ["init", "-b", "main"],
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
      ["worktree", "add", "-b", "feature", worktree],
    ]) {
      yield* git.execute({ operation: "test.setupRepo", cwd: repo, args });
    }
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launchInto = (worktreePath: string) =>
      toolkit
        .handle("t3_thread_launch", {
          title: "Fix",
          projectId,
          workspaceStrategy: { type: "existing_worktree", worktreePath },
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    expect((yield* launchInto(worktree)).at(-1)?.result).toMatchObject({ projectId });
    expect((yield* launchInto(repo)).at(-1)?.result).toMatchObject({ projectId });
    for (const elsewhere of [outside, path.join(worktree, "..", "outside"), "/"]) {
      expect((yield* launchInto(elsewhere)).at(-1)?.result).toMatchObject({
        code: "invalid_request",
      });
    }
    expect(launched.map((launch) => launch.workspaceStrategy)).toEqual([
      { type: "existing_worktree", worktreePath: worktree },
      { type: "existing_worktree", worktreePath: repo },
    ]);

    yield* fileSystem.remove(worktree, { recursive: true });
    yield* fileSystem.makeDirectory(worktree);
    expect((yield* launchInto(worktree)).at(-1)?.result).toMatchObject({
      code: "invalid_request",
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a launch into a new worktree creates nothing when its base ref has no commit", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
      checkWorktreeBase: ({ projectId, workspaceStrategy }) =>
        workspaceStrategy.type === "worktree" && workspaceStrategy.baseRef === "t3/renamed"
          ? Effect.fail(
              new ThreadLaunch.ThreadLaunchBaseRefError({
                projectId,
                projectTitle: "Client target",
                workspaceRoot: "/projects/client-target",
                baseRef: workspaceStrategy.baseRef,
              }),
            )
          : Effect.void,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launchFrom = (baseRef: string) =>
      toolkit
        .handle("t3_thread_launch", {
          title: "Fix",
          projectId,
          workspaceStrategy: { type: "worktree", baseRef, startFromOrigin: false },
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    const refused = (yield* launchFrom("t3/renamed")).at(-1)?.result;
    expect(refused).toMatchObject({ code: "invalid_request" });
    expect((refused as { message: string }).message).toContain(
      'Base ref "t3/renamed" does not resolve to a commit in project "Client target" (/projects/client-target). No thread was created.',
    );
    expect(launched).toHaveLength(0);

    expect((yield* launchFrom("main")).at(-1)?.result).toMatchObject({ projectId });
    expect(launched).toHaveLength(1);
  }),
);

const registrationHarness = (input: {
  readonly access: "read-only" | "approval-required" | "auto-accept-edits" | "auto" | "full-access";
  readonly home: string;
  readonly existing?: ReadonlyArray<string>;
  readonly registered: Array<string>;
  readonly deleted?: Array<string>;
  readonly onCreate?: Effect.Effect<void>;
  readonly onSnapshot?: Effect.Effect<void>;
  /** Run the call from a T3 thread whose shell reads as these, in turn (the last repeats). */
  readonly threadShells?: Array<OrchestrationV2ThreadShell>;
}) =>
  Layer.mergeAll(
    ServerSettings.layerTest(),
    NodeCrypto.layer,
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: "client:session-1",
      thread:
        input.threadShells === undefined
          ? undefined
          : {
              threadId: ThreadId.make("registering-thread"),
              providerSessionId: "session",
              providerInstanceId: ProviderInstanceId.make("codex"),
            },
      client:
        input.threadShells === undefined
          ? { sessionId: "session-1", label: "machine-agent-run", access: input.access }
          : undefined,
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.succeed(HostProcess.HomeDirectory, input.home),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: () =>
        Effect.sync(() => {
          const shells = input.threadShells ?? [];
          return (shells.length > 1 ? shells.shift() : shells[0]) ?? null;
        }),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
    Layer.mock(Project.ProjectService)({
      snapshot: (input.onSnapshot ?? Effect.void).pipe(
        Effect.as({
          projects: (input.existing ?? []).map((workspaceRoot, index) => ({
            id: ProjectId.make(`project:existing-${index}`),
            workspaceRoot,
            deletedAt: null,
          })),
        } as unknown as Effect.Success<Project.ProjectService["Service"]["snapshot"]>),
      ),
      delete: (remove) =>
        Effect.sync(() => {
          input.deleted?.push(remove.projectId);
          return undefined as never;
        }),
      create: (create) =>
        (input.onCreate ?? Effect.void).pipe(
          Effect.andThen(
            Effect.sync(() => {
              input.registered.push(create.workspaceRoot);
              return {
                id: create.projectId,
                title: create.title,
                workspaceRoot: create.workspaceRoot,
                defaultModelSelection: null,
                scripts: [],
                createdAt: "2026-10-01T00:00:00.000Z",
                updatedAt: "2026-10-01T00:00:00.000Z",
                deletedAt: null,
              };
            }),
          ),
        ),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
    Layer.mock(GitVcsDriver.GitVcsDriver)({}),
    NodeServices.layer,
  );

it.effect("a client below full access registers an existing folder under home, and only that", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-register-" });
    const home = path.join(root, "home");
    const repo = path.join(home, "dev", "repo");
    const taken = path.join(home, "dev", "taken");
    const hidden = path.join(home, ".ssh", "keys");
    const library = path.join(home, "Library", "Thing");
    const shoutedLibrary = path.join(home, "LIBRARY", "Keychains");
    // The input schema trims "repo ", so only a symlink can name it.
    const padded = path.join(home, "dev", "repo ");
    const paddedAlias = path.join(home, "dev", "padded-alias");
    const outside = path.join(root, "outside");
    const file = path.join(home, "dev", "notes.txt");
    const alias = path.join(home, "dev", "alias");
    for (const dir of [repo, taken, hidden, library, shoutedLibrary, padded, outside])
      yield* fileSystem.makeDirectory(dir, { recursive: true });
    yield* fileSystem.writeFileString(file, "notes");
    yield* fileSystem.symlink(taken, alias);
    yield* fileSystem.symlink(padded, paddedAlias);
    const realRepo = yield* fileSystem.realPath(repo);

    const run = (
      access: Parameters<typeof registrationHarness>[0]["access"],
      params: Parameters<typeof toolkit.handle<"t3_project_create">>[1],
      registered: Array<string>,
    ) => {
      const dependencies = registrationHarness({ access, home, existing: [taken], registered });
      return ProjectToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
            Layer.provide(dependencies),
          ),
        ),
        Effect.flatMap((built) =>
          built
            .handle("t3_project_create", params)
            .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies)),
        ),
        Effect.map((chunks) => chunks.at(-1)?.result),
      );
    };
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(registrationHarness({ access: "auto", home, registered: [] })),
        ),
      ),
    );

    for (const access of ["approval-required", "auto-accept-edits", "auto"] as const) {
      const registered: Array<string> = [];
      const result = yield* run(access, { title: "Repo", workspaceRoot: repo }, registered);
      expect(result).toMatchObject({ workspaceRoot: realRepo });
      expect(registered).toEqual([realRepo]);
    }

    const refusals: ReadonlyArray<
      readonly [Parameters<typeof toolkit.handle<"t3_project_create">>[1], string]
    > = [
      [{ title: "Named" }, "capability_denied"],
      [
        {
          title: "Make",
          workspaceRoot: path.join(home, "dev", "new"),
          createWorkspaceRootIfMissing: true,
        },
        "capability_denied",
      ],
      [
        {
          title: "Scripted",
          workspaceRoot: repo,
          scripts: [
            { id: "s", name: "s", command: "rm -rf /", icon: "play", runOnWorktreeCreate: false },
          ] as never,
        },
        "capability_denied",
      ],
      [{ title: "Home", workspaceRoot: home }, "capability_denied"],
      [{ title: "Outside", workspaceRoot: outside }, "capability_denied"],
      [{ title: "Hidden", workspaceRoot: hidden }, "capability_denied"],
      [{ title: "Library", workspaceRoot: library }, "capability_denied"],
      [{ title: "Shouted", workspaceRoot: shoutedLibrary }, "capability_denied"],
      [{ title: "Padded", workspaceRoot: paddedAlias }, "invalid_request"],
      [
        { title: "Escape", workspaceRoot: path.join(repo, "..", "..", "..", "outside") },
        "capability_denied",
      ],
      [{ title: "Relative", workspaceRoot: "dev/repo" }, "invalid_request"],
      [{ title: "Missing", workspaceRoot: path.join(home, "dev", "missing") }, "invalid_request"],
      [{ title: "File", workspaceRoot: file }, "invalid_request"],
      [{ title: "Taken", workspaceRoot: taken }, "invalid_request"],
      [{ title: "Alias", workspaceRoot: alias }, "invalid_request"],
    ];
    for (const [params, code] of refusals) {
      const registered: Array<string> = [];
      const result = yield* run("auto", params, registered);
      expect({ title: params.title, result }).toMatchObject({
        title: params.title,
        result: { code },
      });
      expect(registered).toEqual([]);
    }

    const readOnly: Array<string> = [];
    expect(yield* run("read-only", { title: "Repo", workspaceRoot: repo }, readOnly)).toMatchObject(
      {
        code: "capability_denied",
      },
    );
    expect(readOnly).toEqual([]);

    // A folder swapped for a symlink to a hidden folder while it registers is undone.
    const swapped = path.join(home, "dev", "swapped");
    yield* fileSystem.makeDirectory(swapped);
    const swapRegistered: Array<string> = [];
    const swapDeleted: Array<string> = [];
    const swapDependencies = registrationHarness({
      access: "auto",
      home,
      registered: swapRegistered,
      deleted: swapDeleted,
      onCreate: fileSystem
        .remove(swapped, { recursive: true })
        .pipe(Effect.andThen(fileSystem.symlink(hidden, swapped)), Effect.orDie),
    });
    const swappedResult = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(swapDependencies),
        ),
      ),
      Effect.flatMap((built) =>
        built
          .handle("t3_project_create", { title: "Swapped", workspaceRoot: swapped })
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(swapDependencies)),
      ),
      Effect.map((chunks) => chunks.at(-1)?.result),
    );
    expect(swappedResult).toMatchObject({ code: "capability_denied" });
    expect(swapRegistered).toHaveLength(1);
    expect(swapDeleted).toHaveLength(1);

    // Full access keeps its old reach: outside home, as given, without vetting.
    const full: Array<string> = [];
    yield* run("full-access", { title: "Outside", workspaceRoot: outside }, full);
    expect(full).toEqual([outside]);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "a below-full-access registration is refused when the caller or the folder changes during vetting",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-register-race-" });
      const home = path.join(root, "home");
      const repo = path.join(home, "dev", "repo");
      const hidden = path.join(home, ".ssh");
      yield* fileSystem.makeDirectory(repo, { recursive: true });
      yield* fileSystem.makeDirectory(hidden, { recursive: true });

      const create = (
        harness: Parameters<typeof registrationHarness>[0],
        workspaceRoot: string,
      ) => {
        const dependencies = registrationHarness(harness);
        return ProjectToolkit.pipe(
          Effect.provide(
            McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
              Layer.provide(dependencies),
            ),
          ),
          Effect.flatMap((built) =>
            built
              .handle("t3_project_create", { title: "Repo", workspaceRoot })
              .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies)),
          ),
          Effect.map((chunks) => chunks.at(-1)?.result),
        );
      };
      const shell = (changes: Partial<OrchestrationV2ThreadShell>) =>
        ({
          id: ThreadId.make("registering-thread"),
          projectId: ProjectId.make("project:host"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "auto",
          interactionMode: "default",
          activeRunId: "active-run",
          archivedAt: null,
          deletedAt: null,
          ...changes,
        }) as OrchestrationV2ThreadShell;

      const liveRegistered: Array<string> = [];
      expect(
        yield* create(
          { access: "auto", home, registered: liveRegistered, threadShells: [shell({})] },
          repo,
        ),
      ).toMatchObject({ workspaceRoot: yield* fileSystem.realPath(repo) });
      expect(liveRegistered).toHaveLength(1);

      for (const [later, code] of [
        [shell({ interactionMode: "plan" }), "capability_denied"],
        [shell({ activeRunId: null }), "parent_not_active"],
      ] as const) {
        const registered: Array<string> = [];
        const result = yield* create(
          { access: "auto", home, registered, threadShells: [shell({}), later] },
          repo,
        );
        expect(result).toMatchObject({ code });
        expect(registered).toEqual([]);
      }

      // Swapped for a symlink to a hidden folder while vetting: refused before the write.
      const registered: Array<string> = [];
      const deleted: Array<string> = [];
      const result = yield* create(
        {
          access: "auto",
          home,
          registered,
          deleted,
          onSnapshot: fileSystem
            .remove(repo, { recursive: true })
            .pipe(Effect.andThen(fileSystem.symlink(hidden, repo)), Effect.orDie),
        },
        repo,
      );
      expect(result).toMatchObject({ code: "capability_denied" });
      expect(registered).toEqual([]);
      expect(deleted).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
