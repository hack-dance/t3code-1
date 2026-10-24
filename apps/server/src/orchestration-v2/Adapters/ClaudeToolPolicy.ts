import type { ClaudeToolPolicy } from "@t3tools/contracts";

function matches(rule: string, tool: string, command: string): boolean {
  if (rule === tool) return true;
  if (!rule.startsWith(`${tool}(`) || !rule.endsWith(")")) return false;
  const pattern = rule.slice(tool.length + 1, -1);
  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -2);
    return command === prefix || command.startsWith(`${prefix} `);
  }
  const regex = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${regex}$`).test(command);
}

/** Shell syntax and option ambiguity must never inherit a prefix rule's approval. */
function safeShell(command: string): boolean {
  // oxlint-disable-next-line no-control-regex -- Shell control characters must never inherit approvals.
  if (/[\n\r\x00-\x1f\x7f;|&<>`$\\=!*?{}[\]~]/.test(command)) return false;
  const tokens = command.match(/"[^"\n]*"|'[^'\n]*'|[^\s"']+/g);
  if (!tokens || tokens.join(" ") !== command.trim().replace(/\s+/g, " ")) return false;
  const args = tokens.map((token) => token.replace(/^(['"])(.*)\1$/, "$2"));
  if (args[0] === "git") {
    if (args.some((arg) => arg.includes("%G"))) return false;
    return (
      ["diff", "log", "show", "status", "rev-parse", "merge-base", "ls-files", "blame"].includes(
        args[1] ?? "",
      ) &&
      !args.some(
        (arg) =>
          /^-(?:c|o)/.test(arg) ||
          /^--(?:output|exec-path|config-env|ext-diff|textconv|show-signature|help)/.test(arg),
      )
    );
  }
  if (args[0] === "gh") {
    if (
      args.some((arg) =>
        /^(?:--(?:hostname|header|input|field|raw-field|web|browser)|-[fFH])/.test(arg),
      )
    )
      return false;
    if (args[1] === "pr") return ["view", "diff", "checks"].includes(args[2] ?? "");
    if (args[1] !== "api" || args.includes("graphql") || args.includes("/graphql")) return false;
    for (let i = 2; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === "-X" || arg === "--method") {
        if (args[++i] !== "GET") return false;
      } else if (arg.startsWith("-X") || arg.startsWith("--method")) return false;
      else if (
        arg.startsWith("-") &&
        !["--paginate", "--slurp", "--include", "-i", "--silent", "--jq", "-q"].includes(arg)
      )
        return false;
    }
    return true;
  }
  return true;
}

export function claudeToolPolicyAllows(input: {
  policy: ClaudeToolPolicy;
  toolName: string;
  toolInput: unknown;
}): boolean {
  const { policy, toolName, toolInput } = input;
  if (!["Read", "Grep", "Glob", "Bash"].includes(toolName)) return false;
  const command =
    toolName === "Bash" &&
    typeof toolInput === "object" &&
    toolInput !== null &&
    "command" in toolInput &&
    typeof toolInput.command === "string"
      ? toolInput.command
      : "";
  if (toolName === "Bash" && (!command || !safeShell(command))) return false;
  const path =
    typeof toolInput === "object" && toolInput !== null
      ? "file_path" in toolInput && typeof toolInput.file_path === "string"
        ? toolInput.file_path
        : "path" in toolInput && typeof toolInput.path === "string"
          ? toolInput.path
          : ""
      : "";
  const target = toolName === "Bash" ? command : path;
  return (
    !policy.disallowedTools.some((rule) => matches(rule, toolName, target)) &&
    policy.allowedTools.some((rule) => matches(rule, toolName, target))
  );
}
