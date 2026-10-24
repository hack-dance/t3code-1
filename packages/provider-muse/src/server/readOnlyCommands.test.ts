import { describe, expect, it } from "vite-plus/test";

import { isReadOnlyCommand } from "./readOnlyCommands.ts";

describe("isReadOnlyCommand", () => {
  it.each([
    "ls",
    "ls -la /private/tmp/event-agent-tla-workbench-20261023",
    "git status",
    "git status --short",
    "git -C /private/tmp/x status -sb",
    "cd /private/tmp/x && git status && ls -la",
    "git log -5 --oneline",
    "rg -n foo src",
    "find . -name foo.ts",
    "cat package.json",
  ])("accepts %s", (command) => {
    expect(isReadOnlyCommand(command)).toBe(true);
  });

  it.each([
    undefined,
    "",
    "cd /tmp",
    "rm -rf /tmp/x",
    "ls; rm x",
    "ls | sh",
    "ls > out",
    "cat $(whoami)",
    "cat `id`",
    "ls && rm x",
    "ls & rm x",
    "git push",
    "git -c core.pager=sh log",
    "git diff --output=/tmp/x",
    "git diff --ext-diff",
    "find . -delete",
    "find . -exec rm {} ;",
    "rg --pre sh foo",
    "cat ~/.ssh/id_rsa",
    "ls *",
    "echo hi",
    "FOO=1 ls",
    "ls\nrm x",
    "cat 'a b'",
  ])("rejects %s", (command) => {
    expect(isReadOnlyCommand(command)).toBe(false);
  });
});
