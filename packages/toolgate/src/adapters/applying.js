// How each adapter applies the approved hooks and the permissions at launch (the `hooks` and `permissions` capabilities).
// `settingsFlag`: the rules go into the settings file of that launch (Claude Code's `--settings`), session-only, nothing is
// written to the agent's own files. `configEnv`: they go in an inline config the agent reads from the environment (opencode,
// permissions only). `none`: the agent has no such thing. `unknown`: not verified, so nothing is applied and `doctor` says so.
const kind = (value) => Object.freeze({ kind: value });

export const HOOKS_CAPABILITY = Object.freeze({
  "claude-code": kind("settingsFlag"),
  // opencode has plugins (code loaded with no trust step), not hooks.
  opencode: kind("none"),
  codex: kind("unknown"),
  antigravity: kind("unknown"),
  karajan: kind("none"),
  generic: kind("unknown"),
});

export const PERMISSIONS_CAPABILITY = Object.freeze({
  "claude-code": kind("settingsFlag"),
  // Through OPENCODE_CONFIG_CONTENT, which outranks the project's opencode.json (OPENCODE_CONFIG does not).
  opencode: kind("configEnv"),
  codex: kind("unknown"),
  antigravity: kind("unknown"),
  karajan: kind("none"),
  generic: kind("unknown"),
});
