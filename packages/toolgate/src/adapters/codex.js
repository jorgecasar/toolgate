import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeActiveServers, computeActiveTools } from "../activeSet.js";
import { collectInstalled } from "../installed.js";
import { launchStdio, projectRuleFile } from "./shared.js";
import { printable } from "../assets/common.js";
import { COMMANDS_CAPABILITY } from "./commands.js";
import { HOOKS_CAPABILITY, PERMISSIONS_CAPABILITY } from "./applying.js";
import { SUBAGENTS_CAPABILITY } from "./subagents.js";
import { readRuleText, ruleTemplateFile, tomlString } from "../ruleText.js";

// Static capability metadata: Codex CLI loads tool schemas at launch (Class B), so per-tool
// filtering is a real context win. Override via config `client.defersToolSchemas`.
export const capability = Object.freeze({
  commands: COMMANDS_CAPABILITY["codex"],
  subagents: SUBAGENTS_CAPABILITY["codex"],
  hooks: HOOKS_CAPABILITY["codex"],
  permissions: PERMISSIONS_CAPABILITY["codex"],
  defersToolSchemas: false,
  rules: Object.freeze({ kind: "projectFile", path: "AGENTS.md", injectConfigKey: "developer_instructions" }),
  launchGating: "flagOverrides",
  exclusiveMcpConfig: "unknown",
  resume: Object.freeze({ supported: "unknown" }),
  dynamicTools: "unknown",
  passthrough: "args",
});
export const supportsResume = false;

// The `-c` arguments that put this set on the servers the user's Codex config defines; nothing is applied until launch.
export function applyServers(active, toolEnv = {}, defined = []) {
  return serverOverrides(defined, active, toolEnv).args;
}

// Where the Step 0 rule goes for this agent, from its `rules` capability.
export function installDiscovery(ctx) {
  return projectRuleFile(capability, ctx);
}

// Only `[mcp_servers.NAME]` headers are recognised (NAME bare or quoted), with a BOM (JS `\s` covers it), CRLF, spaces and a trailing comment allowed;
// a sub-table such as `[mcp_servers.NAME.env]` is not a server, and neither are `[[...]]`, inline tables or dotted keys.
const SERVER_HEADER = /^\s*\[\s*mcp_servers\s*\.\s*([A-Za-z0-9_-]+|"[^"\\\n]*"|'[^'\n]*')\s*\]\s*(?:#.*)?$/;
function parseTomlServers(toml) {
  const servers = [];
  for (const line of toml.split(/\r?\n/)) {
    const match = line.match(SERVER_HEADER);
    if (match) servers.push(match[1].replace(/^(["'])(.*)\1$/, "$2"));
  }
  return servers;
}
export function readServers(codexConfigPath, { readFileFn = fs.readFileSync } = {}) {
  let raw;
  try {
    raw = readFileFn(codexConfigPath, "utf8");
  } catch {
    return [];
  }
  try {
    return parseTomlServers(raw);
  } catch {
    return [];
  }
}

// Servers the agent has configured (global ~/.codex/config.toml plus the project's
// .codex/config.toml), and the files that say so. `null` when nothing reliable can be concluded.
export function installedServers({ cwd = process.cwd(), homedir = os.homedir(), readFileFn = fs.readFileSync } = {}) {
  return collectInstalled(
    [
      { path: path.join(homedir, ".codex", "config.toml"), parse: parseTomlServers },
      { path: path.join(cwd, ".codex", "config.toml"), parse: parseTomlServers },
    ],
    { readFileFn },
  );
}

export function toEnvVarName(server) {
  return `TOOLGATE_${server.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}_TOOLS`;
}

export function buildToolEnv(config, state, active) {
  const env = {};
  for (const server of Object.keys(config.toolBaselines ?? {})) {
    if (!active.has(server)) continue;
    const tools = computeActiveTools(config, state, server);
    env[toEnvVarName(server)] = [...tools].join(",");
  }
  return env;
}

// Codex splits a `-c` key on dots and quoting does not help, so only these names can be addressed.
const ADDRESSABLE = /^[A-Za-z0-9_-]+$/;

// Codex is launched on the user's own home and told, with `-c` for this launch only, which of the servers it defines to turn off
// and which tools to keep. A `-c` for a server the config does not define breaks the launch, so only defined ones are named.
export function serverOverrides(defined, active, toolEnv = {}) {
  const args = [];
  const notes = [];
  for (const name of [...new Set(defined)].sort()) {
    if (!ADDRESSABLE.test(name)) {
      notes.push(`toolgate: Codex cannot be told about ${printable(name)} from the command line (its name has characters other than letters, digits, - and _); it runs as configured\n`);
    } else if (!active.has(name)) {
      args.push("-c", `mcp_servers.${name}.enabled=false`);
    } else if (toolEnv[toEnvVarName(name)]) {
      const tools = toolEnv[toEnvVarName(name)].split(",").map(tomlString).join(", ");
      args.push("-c", `mcp_servers.${name}.enabled_tools=[${tools}]`);
    }
  }
  return { args, notes };
}

// With `client.injectRule` the Step 0 text goes in as the agent's own developer instructions (`-c key=value`), for this launch only:
// nothing is written and no tracked file is touched. It returns the arguments to add, which go before the user's own (the last
// `-c` of a key wins, and a `--` of theirs would turn anything after it into text). The user's own `-c`/`--config` for the key
// is looked for only before a `--`; theirs wins and a template that cannot be read is said and skipped.
function ruleArgs(userArgs, { config, cwd, stderr, readRuleFn = readRuleText }) {
  if (config?.client?.injectRule !== true) return [];
  const key = capability.rules.injectConfigKey;
  const end = userArgs.indexOf("--");
  const options = end === -1 ? userArgs : userArgs.slice(0, end);
  const setsKey = (value = "") => new RegExp(`^\\s*${key}\\s*=`).test(value);
  const passed = options.some((arg, i) => (/^(?:-c|--config)$/.test(arg) ? setsKey(options[i + 1]) : setsKey(arg.replace(/^(?:-c|--config)=/, "")) && /^(?:-c|--config)=/.test(arg)));
  if (passed) {
    stderr.write(`toolgate: client.injectRule is on, but you passed -c ${key} yourself; the Step 0 rule was not added\n`);
    return [];
  }
  const file = ruleTemplateFile(config, cwd);
  try {
    return ["-c", `${key}=${tomlString(readRuleFn(file))}`];
  } catch {
    stderr.write(`toolgate: client.injectRule is on, but ${JSON.stringify(file)} is not a readable file; launching without the Step 0 rule\n`);
    return [];
  }
}

export function launch({
  prompt,
  headless = false,
  quiet = false,
  agentArgs = [],
  config,
  state,
  env = process.env,
  codexConfigPath = path.join(env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml"),
  spawnFn = spawn,
  readFileFn = fs.readFileSync,
  codexBin = "codex",
  projectDir = process.cwd(),
  stderr = process.stderr,
} = {}) {
  const defined = readServers(codexConfigPath, { readFileFn });
  const active = computeActiveServers(config, state, prompt);
  const toolEnv = buildToolEnv(config, state, active);
  const overrides = serverOverrides(defined, active, toolEnv);
  for (const note of overrides.notes) stderr.write(note);

  // `codex exec` is the non-interactive form; the flags the user passed come last, before the prompt, so their `-c` wins.
  const args = headless && prompt ? ["exec"] : [];
  args.push(...overrides.args, ...ruleArgs(agentArgs, { config, cwd: projectDir, stderr }), ...agentArgs);
  if (prompt) args.push(prompt);

  return new Promise((resolve, reject) => {
    const child = spawnFn(codexBin, args, {
      env: { ...env, ...toolEnv },
      stdio: launchStdio(quiet),
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
}
