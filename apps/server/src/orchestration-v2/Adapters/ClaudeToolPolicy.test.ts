import { describe, expect, it } from "vite-plus/test";
import { claudeToolPolicyAllows } from "./ClaudeToolPolicy.ts";
import { claudeRuntimeQueryPolicyForRuntimePolicy } from "./ClaudeAdapterV2.ts";

const policy = {
  id: "review",
  allowedTools: [
    "Read",
    "Grep",
    "Glob",
    "Bash(gh pr view:*)",
    "Bash(gh pr diff:*)",
    "Bash(gh pr checks:*)",
    "Bash(gh api:*)",
    "Bash(git show:*)",
    "Bash(git diff:*)",
    "Bash(bun test)",
  ],
  disallowedTools: [
    "Edit",
    "Write",
    "Read(*.env*)",
    "Read(*/.ssh/*)",
    "Bash(git *--ext-diff*)",
    "Bash(git *--textconv*)",
    "Bash(git *--output*)",
    "Bash(*=*)",
  ],
};

describe("review tool permissions", () => {
  it("keeps review threads in default mode with a callback even when the caller has full access", () => {
    const result = claudeRuntimeQueryPolicyForRuntimePolicy({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: null,
      claudeToolPolicy: policy,
    });
    expect(result.permissionMode).toBe("default");
    expect(result.installPermissionCallback).toBe(true);
    expect(result.allowDangerouslySkipPermissions).toBeUndefined();
  });

  it("asks for known credential paths even when Read is listed", () => {
    expect(
      claudeToolPolicyAllows({
        policy,
        toolName: "Read",
        toolInput: { file_path: "/project/src/app.ts" },
      }),
    ).toBe(true);
    expect(
      claudeToolPolicyAllows({
        policy,
        toolName: "Read",
        toolInput: { file_path: "/project/.env.local" },
      }),
    ).toBe(false);
    expect(
      claudeToolPolicyAllows({
        policy,
        toolName: "Read",
        toolInput: { file_path: "/home/operator/.ssh/id_ed25519" },
      }),
    ).toBe(false);
  });

  it.each([
    "gh pr view 15 --json title",
    "gh pr diff 15",
    "gh pr checks 15",
    "gh api repos/example/repo/pulls",
    "gh api -X GET repos/example/repo/pulls",
    "gh api --method GET repos/example/repo/pulls",
    "git show HEAD",
    "git diff --stat",
    "bun test",
  ])("allows a listed read or exact test: %s", (command) => {
    expect(claudeToolPolicyAllows({ policy, toolName: "Bash", toolInput: { command } })).toBe(true);
  });

  it.each([
    "gh api https://external.example.com/charge",
    "gh api --paginate graphql",
    "gh api --jq data graphql",
    "git show --format '%GG' HEAD",
    "gh api -X POST repos/a/b/issues",
    "gh api --method=DELETE repos/a/b",
    "gh api -XGET repos/a/b",
    "gh api repos/a/b -f title=x",
    "gh api repos/a/b -F title@file",
    "gh api --input /tmp/body repos/a/b",
    "gh api --header 'X-HTTP-Method-Override: POST' repos/a/b",
    "gh pr view 1 --web",
    "gh pr merge 1",
    "git show --ext-diff",
    "git diff --output /tmp/out",
    "git show --textconv HEAD",
    "git -c core.pager=evil show",
    "git show HEAD; git push",
    "gh pr view 1 && git push",
    "gh pr view $(evil)",
    "gh pr view 1 > file",
    "gh pr view 1\ngit push",
    "bun test --update-snapshots",
    "env bun test",
  ])("asks instead of inheriting a prefix approval: %s", (command) => {
    expect(claudeToolPolicyAllows({ policy, toolName: "Bash", toolInput: { command } })).toBe(
      false,
    );
  });
});
