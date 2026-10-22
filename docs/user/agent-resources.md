# Agent resources

Codex and Claude sessions can use skills and MCP servers from a chosen source, including when a
provider instance uses a different home directory for its account.

Set `T3CODE_AGENT_RESOURCES_FILE` in the T3 server's environment, or in a provider
instance's environment, to a JSON configuration file. For example:

```sh
export T3CODE_AGENT_RESOURCES_FILE=~/.config/t3/agent-resources.json
```

Enable the default sources with:

```json
{
  "codex": {},
  "claude": {}
}
```

Without this environment variable, session behavior is unchanged. Omitting a
provider from the file leaves that provider unchanged.

Codex defaults to `~/.codex/skills` and the `mcp_servers` table in
`~/.codex/config.toml`. Claude defaults to `~/.claude/skills` and merges the
`mcpServers` objects in `~/.claude/settings.json`, `~/.claude/.mcp.json`, and
`~/.claude.json`, in that order. The last file is Claude's native user-scoped MCP
store; later entries with the same name win. Missing default files mean an empty
source. These defaults use the server account's home, independently of
`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, and the instance's configured home.

To choose sources and limit an instance:

```json
{
  "codex": {
    "skillsDirectory": "~/.codex/skills",
    "mcpConfigFile": "~/.codex/config.toml"
  },
  "claude": {
    "skillsDirectory": "~/.claude/skills",
    "mcpConfigFile": "./claude-mcp.json",
    "allowlist": {
      "skills": ["review", "explain"],
      "mcpServers": ["docs"]
    }
  },
  "instances": {
    "instance-a": {
      "skills": ["review"],
      "mcpServers": []
    }
  }
}
```

`instances` keys are provider instance IDs, not display names. Each list overrides
the corresponding provider-level `allowlist` list. An absent list selects all
entries from the source; `[]` selects none. Unknown names select nothing.
Codex skill names come from `SKILL.md` frontmatter, falling back to the directory
name. Claude skill names use the containing folder name, matching its invocation
names even when frontmatter declares a different name. Selected nested Claude
skills are exposed as direct child folders under those names.
Nested directories and linked skills are supported, including Codex's `.system`
directory. Duplicate selected skill names are rejected. An allowlist ignores
unselected broken skills; without one, malformed Codex skills prevent startup.

Relative source paths resolve beside the configuration file. `~` expands to the
server account's home. A relative `T3CODE_AGENT_RESOURCES_FILE` also resolves from
that home. An explicit `mcpConfigFile` replaces the default file list:
use TOML with `mcp_servers` for Codex, or JSON with `mcpServers` for Claude.
Malformed configuration and missing explicit sources prevent the session from
starting rather than falling back to a broader resource set.

The selected resources apply when a provider session opens, including after an
idle session is released. Already-running sessions keep their selection. Restart
the server to apply changes immediately to all sessions. Remove the environment
variable or the provider's entry to return to native resource discovery.

Your provider instance keeps its authentication, history, and runtime state in
its usual home. Selected skills remain available for the session without
rewriting their source files or the instance's configuration. Codex also excludes
skills with the same name at other paths. T3's own tools remain available
independently of the resource lists.

Use a recent Codex release. If startup reports unsupported extra skill roots,
update Codex before enabling this feature.

Resource selection does not grant permissions or override managed provider
policy. On Claude installations with managed MCP configuration, your
administrator's server list takes precedence over these settings. Skill
filtering controls discovery and invocation, not filesystem access.

Paths and configuration live on the environment running the provider, so the
same behavior applies to sessions started from web, desktop, mobile, MCP tools,
and scheduled tasks. Other providers are unchanged. This setting does not change
the provider catalog's background skill suggestions or auxiliary text-generation
calls.

Keep credential-bearing source files private. If resource preparation fails,
the error identifies the file to check without including its contents.
