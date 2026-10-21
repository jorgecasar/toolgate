import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeActiveServers, computeActiveTools } from "../activeSet.js";
import { collectInstalled } from "../installed.js";
import { launchStdio, projectRuleFile } from "./shared.js";
import { COMMANDS_CAPABILITY } from "./commands.js";
import { HOOKS_CAPABILITY, PERMISSIONS_CAPABILITY } from "./applying.js";
import { SUBAGENTS_CAPABILITY } from "./subagents.js";

// Static capability metadata: Antigravity CLI loads tool schemas at launch (Class B), so
// per-tool filtering is a real context win. Override via config `client.defersToolSchemas`.
export const capability = Object.freeze({
  commands: COMMANDS_CAPABILITY["antigravity"],
  subagents: SUBAGENTS_CAPABILITY["antigravity"],
  hooks: HOOKS_CAPABILITY["antigravity"],
  permissions: PERMISSIONS_CAPABILITY["antigravity"],
  defersToolSchemas: false,
  rules: Object.freeze({ kind: "projectFile", path: path.join(".agents", "rules", "toolgate-router.md") }),
  launchGating: "configFile",
  exclusiveMcpConfig: "unknown",
  resume: Object.freeze({ supported: "unknown" }),
  dynamicTools: "unknown",
  passthrough: "args",
});
export const supportsResume = false;

// The mcp_config.json `launch` writes for this set; nothing is applied until launch.
export function applyServers(active, toolEnv = {}) {
  return { configJson: buildConfigJson([...active], toolEnv) };
}

// Where the Step 0 rule goes for this agent, from its `rules` capability.
export function installDiscovery(ctx) {
  return projectRuleFile(capability, ctx);
}

export function readServers(mcpConfigPath, { readFileFn = fs.readFileSync } = {}) {
  let raw;
  try {
    raw = readFileFn(mcpConfigPath, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Object.keys(parsed.mcpServers ?? {});
  } catch {
    return [];
  }
}

// Servers the agent has configured, and the file that says so. `null` when nothing reliable can
// be concluded. Only the global config is known: other Antigravity locations are not read.
export function installedServers({ homedir = os.homedir(), readFileFn = fs.readFileSync } = {}) {
  return collectInstalled(
    [{ path: path.join(homedir, ".gemini", "config", "mcp_config.json"), parse: (raw) => Object.keys(JSON.parse(raw).mcpServers ?? {}) }],
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

export function buildConfigJson(activeServers, toolEnv) {
  const mcpServers = {};
  // Same order as the default sort, spelled out: UTF-16 code units, never locale-dependent.
  for (const server of [...activeServers].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const entry = {};
    const envVarName = toEnvVarName(server);
    if (toolEnv[envVarName]) {
      entry.env = { [envVarName]: toolEnv[envVarName] };
    }
    mcpServers[server] = entry;
  }
  return JSON.stringify({ mcpServers }, null, 2);
}

export function launch({
  prompt,
  headless = false,
  quiet = false,
  agentArgs = [],
  mcpConfigPath = path.join(os.homedir(), ".gemini", "config", "mcp_config.json"),
  config,
  state,
  env = process.env,
  spawnFn = spawn,
  writeFileFn = fs.writeFileSync,
  readFileFn = fs.readFileSync,
  tmpDir = os.tmpdir(),
  antigravityBin = "agy",
  pid = process.pid,
  now = Date.now(),
} = {}) {
  const allServers = readServers(mcpConfigPath, { readFileFn });
  const active = computeActiveServers(config, state, prompt);
  const toolEnv = buildToolEnv(config, state, active);

  const antigravityHome = path.join(tmpDir, `toolgate-antigravity-${pid}-${now}`);
  const configDir = path.join(antigravityHome, ".gemini", "config");
  const resolvedConfigPath = path.join(configDir, "mcp_config.json");

  const configJson = buildConfigJson([...active], toolEnv);
  fs.mkdirSync(configDir, { recursive: true });
  writeFileFn(resolvedConfigPath, configJson);

  // `agy --print=<prompt>` is its non-interactive form (the prompt must be attached to the flag).
  const args = [...agentArgs];
  if (prompt) args.push(headless ? `--print=${prompt}` : prompt);

  return new Promise((resolve, reject) => {
    const child = spawnFn(antigravityBin, args, {
      env: { ...env, ...toolEnv, ANTIGRAVITY_HOME: antigravityHome },
      stdio: launchStdio(quiet),
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      resolve({ code, signal, antigravityHome, resolvedConfigPath, configJson });
    });
  });
}
