import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { addProjectToMachine } from "./addProjectToMachine";

const harness = vi.hoisted(() => ({
  query: vi.fn(),
  command: vi.fn(),
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  executeAtomQuery: harness.query,
  runAtomCommand: harness.command,
  squashAtomCommandFailure: () => new Error("copy failed"),
}));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    subscribe: () => () => {},
    get: () => [{ projectId: "project-1", phase: "done" }],
  },
}));
vi.mock("../state/projectClones", () => ({
  environmentProjectClonesAtom: () => null,
  silenceProjectCloneToasts: () => {},
}));
vi.mock("../state/projects", () => ({
  projectEnvironment: {
    readFile: (input: unknown) => input,
    writeFile: "write",
    filesCopied: "report",
  },
}));
vi.mock("../state/sourceControl", () => ({
  sourceControlEnvironment: { startProjectClone: "clone" },
}));

describe("remote transfer event reporting", () => {
  it.each(["failing", "slow", "disabled"] as const)(
    "finishes file writes with a %s reporting hook and reports only successful names",
    async (mode) => {
      const written = new Map<string, string>();
      let report: (event: Record<string, unknown>) => void = () => {};
      const reported = new Promise<Record<string, unknown>>((resolve) => {
        report = resolve;
      });
      harness.query.mockImplementation(async (_registry, request) => ({
        _tag: "Success",
        value: {
          contents: `EXAMPLE_CONTENT_FOR_${request.input.relativePath}`,
          truncated: false,
        },
      }));
      harness.command.mockImplementation(async (_registry, command, request) => {
        if (command === "clone") {
          return { _tag: "Success", value: { cwd: "/workspace/project" } };
        }
        if (command === "write") {
          if (request.input.relativePath.endsWith("failed.env")) return { _tag: "Failure" };
          written.set(request.input.relativePath, request.input.contents);
          if (mode === "disabled") report({});
          return { _tag: "Success", value: { relativePath: request.input.relativePath } };
        }
        report(request.input);
        if (mode === "failing") throw new Error("hook unavailable");
        return new Promise(() => {});
      });

      await addProjectToMachine({
        source: {
          environmentId: EnvironmentId.make("source"),
          cwd: "/workspace/source",
          label: "host-a",
        },
        target: { environmentId: EnvironmentId.make("target"), label: "build-box" },
        projectId: ProjectId.make("project-1"),
        title: "example-project",
        remoteUrl: "https://example.com/team/project.git",
        destinationPath: "/workspace/project",
        subdirectory: "app",
        files: ["failed.env", ".env"],
        reportTransferEvents: mode !== "disabled",
      });
      const event = await reported;
      const clone = harness.command.mock.calls.find((call) => call[1] === "clone");
      expect(clone).toBeDefined();
      if (mode === "disabled") {
        expect(clone?.[2].input).not.toHaveProperty("transferContext");
      } else {
        expect(clone?.[2].input.transferContext).toEqual({
          sourceLabel: "host-a",
          targetLabel: "build-box",
        });
      }
      expect(written).toEqual(new Map([["app/.env", "EXAMPLE_CONTENT_FOR_.env"]]));
      if (mode !== "disabled") {
        expect(event.files).toEqual(["app/.env"]);
        expect(JSON.stringify(event)).not.toContain("EXAMPLE_CONTENT");
        expect(harness.command.mock.calls.filter((call) => call[1] === "report")).toHaveLength(1);
      } else {
        expect(harness.command.mock.calls.some((call) => call[1] === "report")).toBe(false);
      }
      harness.command.mockClear();
    },
  );
});
