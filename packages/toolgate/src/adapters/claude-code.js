import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeActiveServers, computeActiveTools } from "../activeSet.js";
import { mergeSettings } from "../hooks/effective.js";
import { claudeAgents } from "../subagents/register.js";
import { collectInstalled } from "../installed.js";
import { printable } from "../assets/common.js";
import { disabledActiveLines } from "../claudeSettings.js";
import { guardsOffIn, guardsOffInArgs, guardsOffInFiles, guardsOffLine } from "../guardsOff.js";
import { exitCode, forwardSignals, withResume } from "../wrapper.js";
import { COMMANDS_CAPABILITY } from "./commands.js";
import { HOOKS_CAPABILITY, PERMISSIONS_CAPABILITY } from "./applying.js";
import { SUBAGENTS_CAPABILITY } from "./subagents.js";
import { launchStdio } from "./shared.js";
import { readRuleText, ruleTemplateFile } from "../ruleText.js";

// Claude Code adapter: does NOT rewrite .mcp.json (that file already points heavy servers
// at the proxy, per the Quickstart). It only decides, per launch, which of those servers
// are enabled/disabled and what tool allow-list each proxied server should advertise.

// Static capability metadata: Claude Code with tool search defers tool schemas (Class A,
// SPEC §5 F1), so its value is server routing over per-tool filtering.
export const capability = Object.freeze({
  commands: COMMANDS_CAPABILITY["claude-code"],
  subagents: SUBAGENTS_CAPABILITY["claude-code"],
  hooks: HOOKS_CAPABILITY["claude-code"],
  permissions: PERMISSIONS_CAPABILITY["claude-code"],
  defersToolSchemas: true,
  rules: Object.freeze({ kind: "projectFile", path: path.join(".claude", "rules", "toolgate-router.md"), injectFlag: "--append-system-prompt" }),
  launchGating: "settingsFlag",
  exclusiveMcpConfig: true, // --strict-mcp-config (#77)
  resume: Object.freeze({ supported: true, arg: "--continue" }),
  dynamicTools: true, // honors notifications/tools/list_changed (SPEC F5)
  passthrough: "args",
});
export const supportsResume = true;

// How `toolgate claude …` reads (never rewrites) Claude's arguments; checked against `claude --help`.
export const agentCli = Object.freeze({
  bin: "claude",
  subcommands: Object.freeze([
    "agents", "attach", "auth", "auto-mode", "doctor", "gateway", "import", "install", "logs", "mcp",
    "plugin", "plugins", "purge", "respawn", "rm", "setup-token", "stop", "kill", "ultrareview", "update", "upgrade",
  ]),
  valueFlags: Object.freeze([
    "--agent", "--append-system-prompt", "--effort", "--fallback-model", "--input-format", "--json-schema",
    "--max-budget-usd", "--model", "--output-format", "--permission-mode", "--session-id", "--system-prompt",
    "--settings", "-n", "--name", "--debug-file",
  ]),
  // `--resume [value]` and the like (claude --help): the next word is the value unless it starts with `-`, as Claude reads it.
  optionalValueFlags: Object.freeze(["-r", "--resume", "--from-pr", "--teleport"]),
  nonInteractive: Object.freeze(["-p", "--print"]),
  booleanFlags: Object.freeze([
    "-p", "--print", "-c", "--continue", "--bare", "--dangerously-skip-permissions", "--fork-session", "--verbose",
  ]),
});

// Contract hooks. `applyServers` is the pure half of `launch`: the settings that pin the active set.
export function applyServers(active, allServers = []) {
  return { ...applyActiveSet(active, allServers), enableAllProjectMcpServers: false };
}

// Where the Step 0 rule goes for this agent, from its `rules` capability.
export function installDiscovery({ cwd = process.cwd(), template = "" } = {}) {
  return { file: path.join(cwd, capability.rules.path), content: template };
}

// A JSON file as an object; a missing or malformed one reads as empty.
function readJson(file, readFileFn) {
  try {
    return JSON.parse(readFileFn(file, "utf8")) ?? {};
  } catch {
    return {};
  }
}

export function readServers(mcpJsonPath, { readFileFn = fs.readFileSync } = {}) {
  return Object.keys(readJson(mcpJsonPath, readFileFn).mcpServers ?? {});
}

/**
 * The servers this agent has defined for the launch, `{ name: { command, args, env } }` as its config spells them: the project's .mcp.json.
 * Nothing readable, or not an object of servers, is `{}`.
 */
export function definedServers({ cwd = process.cwd(), readFileFn = fs.readFileSync } = {}) {
  const servers = readJson(path.join(cwd, ".mcp.json"), readFileFn).mcpServers;
  return servers !== null && typeof servers === "object" && !Array.isArray(servers) ? servers : {};
}

const parseMcpServers = (raw) => Object.keys(JSON.parse(raw).mcpServers ?? {});

// ~/.claude.json holds user-scope servers at the top level and local-scope ones per project.
const parseClaudeJson = (cwd) => (raw) => {
  const parsed = JSON.parse(raw);
  return [
    ...Object.keys(parsed.mcpServers ?? {}),
    ...Object.keys(parsed.projects?.[cwd]?.mcpServers ?? {}),
  ];
};

// Servers the agent has configured (project .mcp.json plus user and local scope in
// ~/.claude.json), and the files that say so. `null` when nothing reliable can be concluded.
export function installedServers({ cwd = process.cwd(), homedir = os.homedir(), readFileFn = fs.readFileSync } = {}) {
  return collectInstalled(
    [
      { path: path.join(cwd, ".mcp.json"), parse: parseMcpServers },
      { path: path.join(homedir, ".claude.json"), parse: parseClaudeJson(cwd) },
    ],
    { readFileFn },
  );
}

export function applyActiveSet(active, allServers) {
  return {
    enabledMcpjsonServers: allServers.filter((server) => active.has(server)),
    disabledMcpjsonServers: allServers.filter((server) => !active.has(server)),
  };
}

export function toEnvVarName(server) {
  return `TOOLGATE_${server.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}_TOOLS`;
}

// The proxied server's .mcp.json entry references ${TOOLGATE_<SERVER>_TOOLS} in its own
// `env`, which becomes TOOLGATE_ALLOWED_TOOLS for that server's proxy instance.
export function buildToolEnv(config, state, active) {
  const env = {};
  for (const server of Object.keys(config.toolBaselines ?? {})) {
    if (!active.has(server)) continue;
    const tools = computeActiveTools(config, state, server);
    env[toEnvVarName(server)] = [...tools].join(",");
  }
  return env;
}

// Claude keys ~/.claude.json projects by directory; the nearest one at or above `cwd` is ours.
function projectEntry(projects = {}, cwd) {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    if (projects[dir]) return projects[dir];
    if (path.dirname(dir) === dir) return {};
  }
}

// Server definitions by name, from the lowest precedence to the highest as in Claude: user scope,
// the project's .mcp.json (already parsed), then local scope. Servers the user disabled for this
// project are dropped.
export function readServerDefs({ project = {}, homedir = os.homedir(), cwd = process.cwd(), readFileFn = fs.readFileSync } = {}) {
  const user = readJson(path.join(homedir, ".claude.json"), readFileFn);
  const local = projectEntry(user.projects, cwd);
  const defs = { ...user.mcpServers, ...project.mcpServers, ...local.mcpServers };
  for (const name of local.disabledMcpServers ?? []) delete defs[name];
  return defs;
}

// What a launch adds when the exclusive MCP config is off.
const NO_EXCLUSIVE = { args: [], info: {}, cleanup() {} };

// The exclusive MCP config (#77): exactly the active servers, launched with --strict-mcp-config.
// The file holds the servers' own env (tokens included), so it is private to the user and removed
// on exit (`cleanup`). `info` is what the launch result reports: what was left out, and the active
// names no config file defines (plugin and connector servers, or ones disabled for this project).
function writeExclusiveConfig({ active, project, io }) {
  const { homedir, cwd, writeFileFn, readFileFn, rmFn, stderr, tmpDir, pid, now } = io;
  const defs = readServerDefs({ project, homedir, cwd, readFileFn });
  const mcpServers = Object.fromEntries(Object.entries(defs).filter(([name]) => active.has(name)));
  const leftOut = Object.keys(defs).filter((name) => !active.has(name));
  const undefinedActive = [...active].filter((name) => !(name in defs));
  const mcpConfigPath = path.join(tmpDir, `toolgate-mcp-${pid}-${now}.json`);
  writeFileFn(mcpConfigPath, JSON.stringify({ mcpServers }), { mode: 0o600 });
  stderr.write(`toolgate: exclusive MCP config; left out: ${leftOut.join(", ") || "none"}\n`);
  if (undefinedActive.length) {
    stderr.write(`toolgate: active but defined in no config file, so not loaded: ${undefinedActive.join(", ")}\n`);
  }
  stderr.write("toolgate: plugin and connector servers are not loaded; Claude Code built-ins still are\n");
  return {
    // `--mcp-config` takes a list, so --strict-mcp-config right after it also ends that list.
    args: ["--mcp-config", mcpConfigPath, "--strict-mcp-config"],
    info: { mcpConfigPath, leftOut, undefinedActive },
    cleanup: () => rmFn(mcpConfigPath, { force: true }),
  };
}

// The per-launch settings file that pins the active servers, the env that filters their tools,
// and the exclusive MCP config when the option is on.
function writeSettings({ prompt, mcpJsonPath, config, state, io, applied = {} }) {
  const { writeFileFn, readFileFn, tmpDir, pid, now } = io;
  const project = readJson(mcpJsonPath, readFileFn);
  const active = computeActiveServers(config, state, prompt);
  // The approved hooks and the permissions of toolgate's units go into the same file, merged with the servers it pins.
  const settings = mergeSettings(applyServers(active, Object.keys(project.mcpServers ?? {})), applied.settings ?? {});
  const settingsPath = path.join(tmpDir, `toolgate-settings-${pid}-${now}.json`);
  writeFileFn(settingsPath, JSON.stringify(settings), { mode: 0o600 });
  const exclusive = config?.client?.exclusiveMcp ? writeExclusiveConfig({ active, project, io }) : NO_EXCLUSIVE;
  return { settingsPath, settings, toolEnv: buildToolEnv(config, state, active), exclusive };
}

// Reads one `--settings` value (a file, or inline JSON) as an object. The reason it cannot is short, and never the content.
function readUserSettings(value, readFileFn) {
  const inline = typeof value === "string" && value.trim().startsWith("{");
  let text;
  if (inline) text = value;
  else {
    try {
      text = readFileFn(value, "utf8");
    } catch (err) {
      return { reason: err?.code === "ENOENT" ? "not found" : err?.code === "EACCES" || err?.code === "EPERM" ? "permission denied" : "not readable" };
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { reason: "not valid JSON" };
  }
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? { settings: parsed } : { reason: "not a JSON object" };
}
// Pulls the user's `--settings <file or JSON>` out of the arguments and merges it under ours:
// their keys are kept, but the servers toolgate pins win. One that cannot be read, or is not a JSON object, is left out and said
// once, and the launch goes on with toolgate's own settings (leaving it in would let Claude, which takes the last --settings,
// drop toolgate's deny and ask rules).
function mergeUserSettings(args, ours, { readFileFn, stderr }) {
  const rest = [];
  let theirs = {};
  let touched = false;
  let said = false;
  const read = [];
  for (let i = 0; i < args.length; i++) {
    const inline = args[i].startsWith("--settings=");
    if (args[i] !== "--settings" && !inline) {
      rest.push(args[i]);
      continue;
    }
    const value = inline ? args[i].slice("--settings=".length) : args[++i];
    touched = true;
    const result = value === undefined ? { reason: "not found" } : readUserSettings(value, readFileFn);
    if (result.settings) {
      theirs = { ...theirs, ...result.settings };
      read.push({ where: value.trim().startsWith("{") ? "inline JSON" : value, data: result.settings });
      continue;
    }
    if (!said) {
      const label = value === undefined ? "--settings" : value.trim().startsWith("{") ? "inline JSON" : value;
      stderr.write(`toolgate: your settings ${printable(label)} could not be read (${result.reason}); started with toolgate's permissions only\n`);
      said = true;
    }
  }
  return touched ? { args: rest, settings: mergeSettings(theirs, ours), read } : null;
}
// `--agents <json>` for the active subagents, session-only and written nowhere. The user's own `--agents` is kept:
// theirs win on a name clash; one that is not inline JSON (a file) is left alone and ours are not added.
function withAgents(args, agents) {
  if (Object.keys(agents).length === 0) return { args, note: null };
  const rest = [];
  let theirs = {};
  let found = false;
  for (let i = 0; i < args.length; i++) {
    const inline = args[i].startsWith("--agents=");
    if (args[i] !== "--agents" && !inline) {
      rest.push(args[i]);
      continue;
    }
    const value = inline ? args[i].slice("--agents=".length) : args[++i];
    try {
      if (!value?.trim().startsWith("{")) throw new Error("not inline JSON");
      theirs = { ...theirs, ...JSON.parse(value) };
      found = true;
    } catch {
      return { args, note: "your own --agents is not inline JSON, so the active subagents were not added" };
    }
  }
  return { args: ["--agents", JSON.stringify({ ...agents, ...theirs }), ...(found ? rest : args)], note: null };
}

// With `client.injectRule` the Step 0 text goes in as the agent's own appended system prompt, for this launch only: nothing is
// written and no tracked file is touched. It returns the arguments to add, which go before the user's own (a `--` of theirs would
// turn anything after it into text). The user's own flag wins (their prompt is not merged), looked for only before a `--`;
// a template that cannot be read is said and skipped.
function ruleArgs(userArgs, { config, cwd, stderr, readRuleFn = readRuleText }) {
  if (config?.client?.injectRule !== true) return [];
  const flag = capability.rules.injectFlag;
  const end = userArgs.indexOf("--");
  const options = end === -1 ? userArgs : userArgs.slice(0, end);
  if (options.some((arg) => arg === flag || arg.startsWith(`${flag}=`))) {
    stderr.write(`toolgate: client.injectRule is on, but you passed ${flag} yourself; the Step 0 rule was not added\n`);
    return [];
  }
  const file = ruleTemplateFile(config, cwd);
  try {
    return [flag, readRuleFn(file)];
  } catch {
    stderr.write(`toolgate: client.injectRule is on, but ${JSON.stringify(file)} is not a readable file; launching without the Step 0 rule\n`);
    return [];
  }
}

// The user's own settings can turn toolgate's guards off (see guardsOff.js): respected, and said once before the agent starts.
function announceGuardsOff({ forwarded = [], userArgs, cwd, homedir, stderr }) {
  const entries = [
    ...guardsOffInFiles({ cwd, homedir }),
    ...forwarded.flatMap(({ where, data }) => guardsOffIn(data).map((setting) => ({ setting, where }))),
    ...guardsOffInArgs(userArgs),
  ];
  const line = guardsOffLine([...new Map(entries.map((e) => [`${e.setting} in ${e.where}`, e])).values()]);
  if (line) stderr.write(line);
}
// A server toolgate activates that one of the user's settings files disables is never loaded by Claude Code (a disable in any file wins).
function announceDisabledActive({ active = [], cwd, homedir, stderr }) {
  for (const line of disabledActiveLines({ active, cwd, homedir })) stderr.write(line);
}
// `launch(options)` starts Claude for a prompt; `launch(args, options)` forwards the user's own
// arguments untouched (`toolgate claude …`), adding only what toolgate generates.
export function launch(first, second) {
  return Array.isArray(first) ? launchPassthrough(first, second) : launchPrompt(first);
}

function launchPassthrough(
  args,
  {
    prompt,
    subagents = [],
    applied,
    resume = false,
    raw = false,
    mcpJsonPath = ".mcp.json",
    config,
    state,
    env = process.env,
    spawnFn = spawn,
    writeFileFn = fs.writeFileSync,
    readFileFn = fs.readFileSync,
    rmFn = fs.rmSync,
    tmpDir = os.tmpdir(),
    claudeBin = "claude",
    pid = process.pid,
    now = Date.now(),
    signalSource = process,
    homedir = os.homedir(),
    cwd = process.cwd(),
    stderr = process.stderr,
  } = {},
) {
  let finalArgs = withResume(args, capability.resume.arg, resume);
  let childEnv = env;
  let generated = {};
  let cleanup = () => {};
  // Subcommands (`mcp`, `doctor`, …) open no session to govern: nothing is generated for them.
  if (!raw) {
    const { settingsPath, settings, toolEnv, exclusive } = writeSettings({
      prompt, mcpJsonPath, config, state, applied,
      io: { writeFileFn, readFileFn, rmFn, stderr, tmpDir, pid, now, homedir, cwd },
    });
    // What toolgate made for this launch goes when the agent ends, or cannot start: the exclusive config and the hook copies.
    cleanup = () => {
      rmFn(settingsPath, { force: true });
      exclusive.cleanup();
      applied?.cleanup?.();
    };
    // Claude honors only the last --settings (verified: they are not merged), so the user's own
    // is folded into the generated file instead of being left to override it.
    const merged = mergeUserSettings(finalArgs, settings, { readFileFn, stderr });
    if (merged) writeFileFn(settingsPath, JSON.stringify(merged.settings), { mode: 0o600 });
    const agents = withAgents(merged ? merged.args : finalArgs, claudeAgents(subagents));
    if (agents.note) stderr.write(`toolgate: ${agents.note}\n`);
    announceGuardsOff({ forwarded: merged?.read, userArgs: finalArgs, cwd, homedir, stderr });
    announceDisabledActive({ active: settings.enabledMcpjsonServers, cwd, homedir, stderr });
    finalArgs = ["--settings", settingsPath, ...ruleArgs(agents.args, { config, cwd, stderr }), ...exclusive.args, ...agents.args];
    childEnv = { ...env, ...toolEnv };
    generated = { settingsPath, ...settings, toolEnv, ...exclusive.info };
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn(claudeBin, finalArgs, { env: childEnv, stdio: "inherit" });
    } catch (error) {
      // An agent that cannot be run at all (not a program) throws here, before the listeners that clean up exist.
      try {
        cleanup();
      } catch {
        // the reason the agent did not start is the one to report, not a failure of the cleanup
      }
      throw error;
    }
    const stopForwarding = forwardSignals(child, signalSource);

    // A failed spawn emits `error`, not `exit`: the config file still goes, and the launch rejects (an agent that is missing, or not
    // executable), so the caller can keep what it consumed for it.
    child.on("error", (error) => {
      stopForwarding();
      try {
        cleanup();
      } catch {
        // the reason the agent did not start is the one to report, not a failure of the cleanup
      }
      reject(error);
    });
    child.on("exit", (code, signal) => {
      stopForwarding();
      cleanup();
      resolve({ code: exitCode({ code, signal }), signal, args: finalArgs, ...generated });
    });
  });
}

function launchPrompt({
  prompt,
  headless = false,
  quiet = false,
  agentArgs = [],
  subagents = [],
  applied,
  mcpJsonPath = ".mcp.json",
  config,
  state,
  env = process.env,
  spawnFn = spawn,
  writeFileFn = fs.writeFileSync,
  readFileFn = fs.readFileSync,
  rmFn = fs.rmSync,
  tmpDir = os.tmpdir(),
  claudeBin = "claude",
  pid = process.pid,
  now = Date.now(),
  homedir = os.homedir(),
  cwd = process.cwd(),
  stderr = process.stderr,
  signalSource = process,
} = {}) {
  const { settingsPath, settings, toolEnv, exclusive } = writeSettings({
    prompt, mcpJsonPath, config, state, applied,
    io: { writeFileFn, readFileFn, rmFn, stderr, tmpDir, pid, now, homedir, cwd },
  });
  const { enabledMcpjsonServers, disabledMcpjsonServers } = settings;

  // The same as the wrapper path: their --settings is folded into ours and their --agents gets ours added.
  const merged = mergeUserSettings(agentArgs, settings, { readFileFn, stderr });
  if (merged) writeFileFn(settingsPath, JSON.stringify(merged.settings), { mode: 0o600 });
  const agents = withAgents(merged ? merged.args : agentArgs, claudeAgents(subagents));
  if (agents.note) stderr.write(`toolgate: ${agents.note}\n`);
  announceGuardsOff({ forwarded: merged?.read, userArgs: agentArgs, cwd, homedir, stderr });
  announceDisabledActive({ active: enabledMcpjsonServers, cwd, homedir, stderr });
  const args = ["--settings", settingsPath, ...ruleArgs([], { config, cwd, stderr }), ...exclusive.args, ...agents.args];
  // `-p` is Claude's non-interactive form.
  if (prompt) args.push(...(headless ? ["-p", prompt] : [prompt]));

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      rmFn(settingsPath, { force: true });
      exclusive.cleanup();
      applied?.cleanup?.();
    };
    let child;
    try {
      child = spawnFn(claudeBin, args, { env: { ...env, ...toolEnv }, stdio: launchStdio(quiet) });
    } catch (error) {
      // An agent that cannot be run at all (not a program) throws here, before the listeners that clean up exist.
      try {
        cleanup();
      } catch {
        // the reason the agent did not start is the one to report, not a failure of the cleanup
      }
      throw error;
    }
    // Ctrl-C or a TERM to toolgate reaches the agent, which ends, and then everything made for this launch is removed.
    const stopForwarding = forwardSignals(child, signalSource);
    child.on("error", (error) => {
      stopForwarding();
      try {
        cleanup();
      } catch {
        // the reason the agent did not start is the one to report, not a failure of the cleanup
      }
      reject(error);
    });
    child.on("exit", (code, signal) => {
      stopForwarding();
      cleanup();
      // A signal that ended the agent is 128 + its number, like the wrapper path: a TERM must not look like success.
      resolve({ code: exitCode({ code, signal }), signal, settingsPath, enabledMcpjsonServers, disabledMcpjsonServers, toolEnv, ...exclusive.info });
    });
  });
}
