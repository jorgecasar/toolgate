// Where each agent keeps the subagents of its own and how their files are written. Plain data, shared by
// `toolgate subagents import` and `doctor`, which have to know the folders without loading every adapter.
// Paths are relative to the project or to the user's home directory.
const dirs = (list) => Object.freeze([...list]);
const native = (dialect, projectDirs, userDirs) => Object.freeze({ kind: "nativeDir", dialect, projectDirs: dirs(projectDirs), userDirs: dirs(userDirs) });

/**
 * How each adapter registers the active subagents at launch (the `subagents` capability): `launchFlag` passes them
 * on the command line for that session only (nothing is written), `projectDir` writes marked files in a folder the
 * agent reads and removes them afterwards, `none` and `unknown` register nothing.
 */
export const SUBAGENTS_CAPABILITY = Object.freeze({
  "claude-code": Object.freeze({ kind: "launchFlag", flag: "--agents" }),
  opencode: Object.freeze({ kind: "projectDir", dialect: "opencode", dir: ".opencode/agents" }),
  codex: Object.freeze({ kind: "unknown" }),
  antigravity: Object.freeze({ kind: "unknown" }),
  karajan: Object.freeze({ kind: "none" }),
  generic: Object.freeze({ kind: "unknown" }),
});

export const SUBAGENTS_NATIVE = Object.freeze({
  "claude-code": native("claude", [".claude/agents"], [".claude/agents"]),
  opencode: native("opencode", [".opencode/agents"], [".config/opencode/agents"]),
});
