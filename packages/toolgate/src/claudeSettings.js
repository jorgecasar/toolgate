// Settings of the user's own Claude Code that change what toolgate prepares for a launch, read from the three files Claude Code reads
// (`~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`), the way guardsOff.js reads them. Respected, never
// changed: doctor says what they do, and a launch says when one disables a server toolgate activates. A file that cannot be read says nothing.
import fs from "node:fs";
import { claudeSettingsFile, readSettings } from "./assets/nativeSettings.js";
import { printable } from "./assets/common.js";

// Once each, in order: one finding per file and name, however many times a list repeats it.
const strings = (value) => (Array.isArray(value) ? [...new Set(value.filter((item) => typeof item === "string"))] : []);

/** The readable settings objects, each with the label that names its file. */
export function claudeSettingsFiles({ cwd, homedir }) {
  const files = [];
  for (const level of ["user", "project", "local"]) {
    try {
      const source = claudeSettingsFile({ level, projectDir: cwd, homeDir: homedir });
      const { data } = readSettings(source);
      if (data) files.push({ where: source.label, data });
    } catch {
      // Unreadable settings are not ours to report here.
    }
  }
  return files;
}

/** The labels of the settings files that are symbolic links: never followed, so never read. */
export function symlinkedSettings({ cwd, homedir }) {
  const labels = [];
  for (const level of ["user", "project", "local"]) {
    const source = claudeSettingsFile({ level, projectDir: cwd, homeDir: homedir });
    try {
      if (fs.lstatSync(source.file, { throwIfNoEntry: false })?.isSymbolicLink()) labels.push(source.label);
    } catch {
      // Not readable: not ours to report here.
    }
  }
  return labels;
}

/** The servers a settings object disables: Claude Code rejects them whatever toolgate's `--settings` enables, since a disable in any file wins. */
export const disabledServersIn = (data) => strings(data?.disabledMcpjsonServers);

/** The servers a settings object pins in `enabledMcpjsonServers`. */
export const pinnedServersIn = (data) => strings(data?.enabledMcpjsonServers);

const STEP0_COMMAND = "toolgate need x";
// `*` is any text. Anchored at both ends and decided by plain comparisons (the pieces between the stars, found in order), never a regular
// expression built from the user's pattern: a file in a cloned repository must not be able to hang doctor with a pattern of many stars.
function globMatches(pattern, text) {
  const parts = pattern.split("*");
  if (parts.length === 1) return pattern === text;
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (text.length < first.length + last.length || !text.startsWith(first) || !text.endsWith(last)) return false;
  let at = first.length;
  const end = text.length - last.length;
  for (const part of parts.slice(1, -1)) {
    const found = text.indexOf(part, at);
    if (found === -1 || found + part.length > end) return false;
    at = found + part.length;
  }
  return true;
}
// A permission rule is `Tool` or `Tool(pattern)`; `*` is any text and a trailing `:*` is "this prefix, with or without arguments".
function matchesStep0(rule) {
  const parsed = /^([^()]+?)(?:\((.*)\))?$/s.exec(rule.trim());
  if (!parsed || parsed[1] !== "Bash") return false;
  const pattern = parsed[2];
  if (pattern === undefined || pattern === "" || pattern === "*") return true;
  if (!pattern.endsWith(":*")) return globMatches(pattern, STEP0_COMMAND);
  const prefix = pattern.slice(0, -2);
  return globMatches(prefix, STEP0_COMMAND) || globMatches(`${prefix} *`, STEP0_COMMAND);
}

/** The `permissions.deny` and `permissions.ask` rules that match the Step 0 command (`toolgate need`): a deny blocks it, an ask prompts before it. */
export function step0RulesIn(data) {
  const found = [];
  for (const list of ["deny", "ask"]) {
    for (const rule of strings(data?.permissions?.[list])) if (matchesStep0(rule)) found.push({ list, rule });
  }
  return found;
}

/** The variables of an `env` block that toolgate also sets at launch: the file's value replaces toolgate's, for the MCP servers at least. */
export const envOverridesIn = (data) =>
  data?.env !== null && typeof data?.env === "object" && !Array.isArray(data.env)
    ? Object.keys(data.env).filter((name) => name.startsWith("TOOLGATE_") || name === "QMD_SHARED_PORT")
    : [];

/** The one line per active server that a settings file disables, for a launch to print. */
export function disabledActiveLines({ active, cwd, homedir }) {
  const wanted = new Set(active);
  const lines = [];
  for (const { where, data } of claudeSettingsFiles({ cwd, homedir })) {
    for (const server of disabledServersIn(data)) {
      if (wanted.has(server)) lines.push(`toolgate: ${printable(server)} is active but ${printable(where)} disables it (disabledMcpjsonServers), so Claude Code will not load it\n`);
    }
  }
  return lines;
}
