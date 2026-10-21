// Settings of the user's own Claude Code that turn toolgate's guards off for a session: `disableAllHooks` (toolgate's hooks do not run)
// and a `bypassPermissions` default mode (its ask rules do not prompt). Toolgate respects them and says so, at launch and in doctor.
import { claudeSettingsFile, readSettings } from "./assets/nativeSettings.js";
import { printable } from "./assets/common.js";

const HOOKS_OFF = "disableAllHooks";
const ASK_OFF = "permissions.defaultMode bypassPermissions";

/** The guard-off settings one Claude Code settings object holds; any other value says nothing. */
export function guardsOffIn(data) {
  const found = [];
  if (data?.disableAllHooks === true) found.push(HOOKS_OFF);
  if (data?.permissions?.defaultMode === "bypassPermissions") found.push(ASK_OFF);
  return found;
}

/** The same, for the three files Claude Code reads: `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`. A file that cannot be read says nothing. */
export function guardsOffInFiles({ cwd, homedir }) {
  const entries = [];
  for (const level of ["user", "project", "local"]) {
    try {
      const source = claudeSettingsFile({ level, projectDir: cwd, homeDir: homedir });
      for (const setting of guardsOffIn(readSettings(source).data)) entries.push({ setting, where: source.label });
    } catch {
      // Unreadable settings are not ours to report here.
    }
  }
  return entries;
}

/** The flags that skip the permission prompts, looked for only before a `--`. */
export function guardsOffInArgs(args) {
  const end = args.indexOf("--");
  const options = end === -1 ? args : args.slice(0, end);
  const entries = [];
  if (options.includes("--dangerously-skip-permissions")) entries.push({ setting: ASK_OFF, where: "the --dangerously-skip-permissions flag" });
  if (options.some((arg, i) => (arg === "--permission-mode" && options[i + 1] === "bypassPermissions") || arg === "--permission-mode=bypassPermissions")) entries.push({ setting: ASK_OFF, where: "the --permission-mode flag" });
  return entries;
}

/** The one line a launch prints, or null when nothing turns the guards off. */
export const guardsOffLine = (entries) =>
  entries.length ? `toolgate: your Claude Code settings turn off toolgate's guards for this session: ${entries.map((e) => `${e.setting} in ${printable(e.where)}`).join(", ")}\n` : null;
