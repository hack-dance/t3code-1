import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ProjectFilesCopiedInput } from "./projectTransfer.ts";
import { ProjectCloneStartInput } from "./projectClone.ts";

const decode = Schema.decodeUnknownSync(ProjectFilesCopiedInput);
const decodeClone = Schema.decodeUnknownSync(ProjectCloneStartInput);
const report = {
  context: { sourceLabel: "host-a", targetLabel: "build-box" },
  projectName: "example-project",
  remoteUrl: "https://example.com/team/project.git",
  destinationPath: "/workspace/project",
  files: [".env"],
};

describe("copied-file report limits", () => {
  it("does not apply report limits to labels on clone requests", () => {
    const context = { sourceLabel: "a".repeat(257), targetLabel: "b".repeat(257) };
    expect(
      decodeClone({
        projectId: "project-1",
        title: report.projectName,
        createdAt: "2026-01-01T00:00:00.000Z",
        destinationPath: report.destinationPath,
        remoteUrl: report.remoteUrl,
        transferContext: context,
      }).transferContext,
    ).toEqual(context);
  });

  it("accepts reports at the metadata limits", () => {
    const bounded = {
      context: { sourceLabel: "a".repeat(256), targetLabel: "b".repeat(256) },
      projectName: "p".repeat(256),
      remoteUrl: "r".repeat(8192),
      destinationPath: "d".repeat(4096),
      files: Array.from({ length: 200 }, () => "f".repeat(512)),
    };
    expect(decode(bounded)).toEqual(bounded);
  });

  it.each([
    ["source label", { context: { ...report.context, sourceLabel: "a".repeat(257) } }],
    ["target label", { context: { ...report.context, targetLabel: "b".repeat(257) } }],
    ["project name", { projectName: "p".repeat(257) }],
    ["remote URL", { remoteUrl: "r".repeat(8193) }],
    ["destination path", { destinationPath: "d".repeat(4097) }],
    ["file name", { files: ["f".repeat(513)] }],
    ["file count", { files: Array.from({ length: 201 }, () => ".env") }],
  ] as const)("rejects oversized %s before delivery", (_name, oversized) => {
    expect(() => decode({ ...report, ...oversized })).toThrow();
  });
});
