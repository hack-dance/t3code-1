import * as NodeOS from "node:os";

import { OrchestratorMcpFailure, type ProjectCreatePayload } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as Project from "../../../project/ProjectService.ts";
import type { Caller } from "../../threadAccess.ts";

/**
 * The directory a caller below full access may register projects under. Tests
 * point it at a temporary directory.
 */
export const ProjectRegistrationHome = Context.Reference<string>(
  "t3/mcp/project/registrationHome",
  { defaultValue: () => NodeOS.homedir() },
);

type CreateParams = Omit<ProjectCreatePayload, "workspaceRoot"> & {
  readonly workspaceRoot?: string | undefined;
};

const needsFullAccess = (why: string) =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message: `${why} Below full access a caller may only register an existing directory inside the user's home folder.`,
  });

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/**
 * Vets a `t3_project_create` call from a supervised or auto caller. Registering
 * an existing folder only records it, so it is allowed; creating folders,
 * saving scripts (which later run as commands) and registering anything
 * outside home, home itself, a hidden folder or ~/Library still need full
 * access. Returns the params with `workspaceRoot` resolved to its real path, so
 * a symlink cannot register a second project for the same folder.
 */
export const vetProjectRegistration = Effect.fn("mcp.vetProjectRegistration")(function* <
  P extends CreateParams,
>(params: P, caller: Caller) {
  if (params.workspaceRoot === undefined)
    return yield* needsFullAccess("Starting a new project from a title creates a folder.");
  if (params.createWorkspaceRootIfMissing === true)
    return yield* needsFullAccess("createWorkspaceRootIfMissing creates a folder.");
  if (params.scripts !== undefined && params.scripts.length > 0)
    return yield* needsFullAccess("Saved project scripts run as commands.");

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!path.isAbsolute(params.workspaceRoot))
    return yield* invalid("workspaceRoot must be an absolute path.");

  const real = yield* fileSystem
    .realPath(params.workspaceRoot)
    .pipe(Effect.mapError(() => invalid("workspaceRoot does not exist.")));
  const info = yield* fileSystem
    .stat(real)
    .pipe(Effect.mapError(() => invalid("workspaceRoot does not exist.")));
  if (info.type !== "Directory") return yield* invalid("workspaceRoot must be a directory.");

  const configuredHome = yield* ProjectRegistrationHome;
  const home = yield* fileSystem
    .realPath(configuredHome)
    .pipe(Effect.orElseSucceed(() => configuredHome));
  const relative = path.relative(home, real);
  const segments = relative.split(path.sep);
  if (relative === "" || path.isAbsolute(relative) || segments[0] === "..")
    return yield* needsFullAccess("workspaceRoot is outside the user's home folder.");
  if (segments.some((segment) => segment.startsWith(".")))
    return yield* needsFullAccess("workspaceRoot is inside a hidden folder.");
  if (segments[0] === "Library")
    return yield* needsFullAccess("workspaceRoot is inside ~/Library.");

  const projects = yield* Project.ProjectService;
  const snapshot = yield* projects.snapshot.pipe(
    Effect.mapError(
      () =>
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "The operation could not be completed.",
        }),
    ),
  );
  for (const project of snapshot.projects) {
    if (project.deletedAt !== null) continue;
    const existing = yield* fileSystem
      .realPath(project.workspaceRoot)
      .pipe(Effect.orElseSucceed(() => project.workspaceRoot));
    if (existing === real)
      return yield* invalid(`The workspace is already registered to project ${project.id}.`);
  }

  yield* Effect.logInfo("registering a project below full access", {
    workspaceRoot: real,
    runtimeMode: caller.limits.runtimeMode,
    client: caller.scope.client?.label,
    threadId: caller.scope.thread?.threadId,
  });
  const vetted: P = { ...params, workspaceRoot: real };
  return vetted;
});
