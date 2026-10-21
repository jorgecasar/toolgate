// Where each agent keeps the slash commands of its own and how they are written (the `commands`
// capability, docs/ADAPTERS.md). Plain data, shared by the adapters and by `toolgate commands import`,
// which has to know the folders without loading every adapter. Paths are relative to the project or to
// the user's home directory.
const dirs = (list) => Object.freeze([...list]);
const native = (dialect, format, projectDirs, userDirs) =>
  Object.freeze({ kind: "nativeDir", dialect, format, projectDirs: dirs(projectDirs), userDirs: dirs(userDirs) });

export const COMMANDS_CAPABILITY = Object.freeze({
  "claude-code": native("claude", "markdown", [".claude/commands"], [".claude/commands"]),
  opencode: native("opencode", "markdown", [".opencode/command", ".opencode/commands"], [".config/opencode/command", ".config/opencode/commands"]),
  // Codex reads custom prompts from the user's folder only.
  codex: native("codex", "markdown", [], [".codex/prompts"]),
  // Antigravity keeps its reusable prompts as workflows. The first folder of a list is where toolgate writes
  // the bridge command.
  antigravity: native("antigravity", "markdown", [".agents/workflows", ".agents/commands"], []),
  karajan: Object.freeze({ kind: "none" }),
  generic: Object.freeze({ kind: "unknown" }),
});
