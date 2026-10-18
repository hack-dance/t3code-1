// @effect-diagnostics nodeBuiltinImport:off - FileSystem.realPath keeps the caller's letter case on
// case-insensitive volumes; the guards below need the OS's canonical path.
import * as NodeFSP from "node:fs/promises";

import {
  OrchestratorMcpFailure,
  type Project as ProjectRecord,
  type ProjectCreatePayload,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as Project from "../../../project/ProjectService.ts";
import { newCommandId, type Caller } from "../../threadAccess.ts";

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

const unavailable = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "The operation could not be completed.",
  });

/**
 * The OS's canonical path. Unlike Effect's `realPath` (Node's JS `fs.realpath`)
 * it also canonicalises letter case on case-insensitive volumes, so `~/LIBRARY`
 * resolves to `~/Library`.
 */
const canonicalPath = (target: string) =>
  Effect.tryPromise({
    try: () => NodeFSP.realpath(target),
    catch: () => invalid("workspaceRoot does not exist."),
  });

/**
 * The canonical directory a caller below full access may register for
 * `workspaceRoot`, or why not. The result is a path the project service stores
 * unchanged: absolute, no surrounding whitespace, no symlinks.
 */
const vetWorkspaceRoot = Effect.fn("mcp.vetWorkspaceRoot")(function* (workspaceRoot: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!path.isAbsolute(workspaceRoot))
    return yield* invalid("workspaceRoot must be an absolute path.");

  const real = yield* canonicalPath(workspaceRoot);
  // The project service trims and resolves what it stores, so a path it would
  // rewrite could name a different folder from the one vetted here.
  // oxlint-disable-next-line no-control-regex
  if (real !== real.trim() || path.resolve(real) !== real || /[\u0000-\u001f]/.test(real))
    return yield* invalid(
      "workspaceRoot must not start or end with whitespace or contain control characters.",
    );
  const info = yield* fileSystem
    .stat(real)
    .pipe(Effect.mapError(() => invalid("workspaceRoot does not exist.")));
  if (info.type !== "Directory") return yield* invalid("workspaceRoot must be a directory.");

  const configuredHome = yield* HostProcess.HomeDirectory;
  const home = yield* canonicalPath(configuredHome).pipe(
    Effect.orElseSucceed(() => configuredHome),
  );
  const relative = path.relative(home, real);
  const segments = relative.split(path.sep);
  if (relative === "" || path.isAbsolute(relative) || segments[0] === "..")
    return yield* needsFullAccess("workspaceRoot is outside the user's home folder.");
  if (segments.some((segment) => segment.startsWith(".")))
    return yield* needsFullAccess("workspaceRoot is inside a hidden folder.");
  if (segments[0]?.toLowerCase() === "library")
    return yield* needsFullAccess("workspaceRoot is inside ~/Library.");
  return real;
});

/**
 * Vets a `t3_project_create` call from a supervised or auto caller. Registering
 * an existing folder only records it, so it is allowed; creating folders,
 * saving scripts (which later run as commands) and registering anything
 * outside home, home itself, a hidden folder or ~/Library still need full
 * access. Returns the params with `workspaceRoot` canonicalised, so a symlink
 * or another spelling cannot register a second project for the same folder.
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

  const real = yield* vetWorkspaceRoot(params.workspaceRoot);

  const projects = yield* Project.ProjectService;
  const snapshot = yield* projects.snapshot.pipe(Effect.mapError(unavailable));
  for (const project of snapshot.projects) {
    if (project.deletedAt !== null) continue;
    const existing = yield* canonicalPath(project.workspaceRoot).pipe(
      Effect.orElseSucceed(() => project.workspaceRoot),
    );
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

/**
 * The last check before the project is written: the vetted folder must still
 * canonicalise to itself and pass the guards, so a swap during vetting is
 * refused before anything is published.
 */
export const recheckProjectRegistration = Effect.fn("mcp.recheckProjectRegistration")(function* <
  P extends CreateParams,
>(vetted: P) {
  const root = vetted.workspaceRoot;
  const now = root === undefined ? undefined : yield* vetWorkspaceRoot(root);
  if (now === undefined || now !== root)
    return yield* needsFullAccess("workspaceRoot changed while it was being registered.");
});

/**
 * Re-vets what was registered below full access. The folder can be swapped
 * (say for a symlink to ~/.ssh) between vetting and creation; if the stored
 * root no longer canonicalises to the vetted folder, the project is deleted
 * again and the call fails.
 */
export const confirmProjectRegistration = Effect.fn("mcp.confirmProjectRegistration")(function* <
  P extends CreateParams,
  A extends Pick<ProjectRecord, "id" | "workspaceRoot">,
>(vetted: P, created: A) {
  const now = yield* vetWorkspaceRoot(created.workspaceRoot).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  if (now !== undefined && now === vetted.workspaceRoot && now === created.workspaceRoot)
    return created;
  // Best effort: the recheck already ran just before the write, so reaching
  // here means a swap in the moment between it and the service's own stat. A
  // non-forced delete never removes threads someone attached meanwhile; if it
  // fails, the leftover is logged so it can be found.
  const projects = yield* Project.ProjectService;
  const commandId = yield* newCommandId();
  yield* projects.delete({ projectId: created.id, commandId }).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("could not undo a project registration whose folder changed", {
        projectId: created.id,
        workspaceRoot: created.workspaceRoot,
        error: error._tag,
      }),
    ),
    Effect.mapError(unavailable),
  );
  yield* Effect.logWarning("undid a project registration whose folder changed", {
    projectId: created.id,
    workspaceRoot: created.workspaceRoot,
  });
  return yield* needsFullAccess("workspaceRoot changed while it was being registered.");
});
