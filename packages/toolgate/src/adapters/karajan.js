import { spawn } from "node:child_process";
import fs from "node:fs";
import { computeActiveServers, computeActiveTools } from "../activeSet.js";
import { COMMANDS_CAPABILITY } from "./commands.js";
import { HOOKS_CAPABILITY, PERMISSIONS_CAPABILITY } from "./applying.js";
import { SUBAGENTS_CAPABILITY } from "./subagents.js";
import { launchStdio } from "./shared.js";

// Static capability metadata: Karajan sub-agents run per-role CLIs that load tool schemas at
// launch (Class B), so per-tool filtering is a real context win per injected profile.
export const capability = Object.freeze({
  commands: COMMANDS_CAPABILITY["karajan"],
  subagents: SUBAGENTS_CAPABILITY["karajan"],
  hooks: HOOKS_CAPABILITY["karajan"],
  permissions: PERMISSIONS_CAPABILITY["karajan"],
  defersToolSchemas: false,
  rules: Object.freeze({ kind: "unknown" }),
  launchGating: "none", // gating is per spawned sub-agent, see computeProxyEnv
  exclusiveMcpConfig: "unknown",
  resume: Object.freeze({ supported: "unknown" }),
  dynamicTools: "unknown",
  passthrough: "args",
});
export const supportsResume = false;

export function applyServers(active, toolEnv = {}) {
  return { activeServers: [...active], proxyEnv: { ...toolEnv } };
}

export function installDiscovery() {
  return null;
}

// Runs the Karajan pipeline (`kj`) with the proxy env of the routed task.
// `kj run <task>` is already one-shot, so there is no separate non-interactive form.
export function launch({ prompt, config, state, quiet = false, env = process.env, spawnFn = spawn, kjBin = "kj" } = {}) {
  const { toolEnv } = computeProxyEnv({ role: prompt, config, state });
  const args = prompt ? ["run", prompt] : [];
  return new Promise((resolve, reject) => {
    const child = spawnFn(kjBin, args, { env: { ...env, ...toolEnv }, stdio: launchStdio(quiet) });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal, toolEnv }));
  });
}

export function readServers(mcpJsonPath, { readFileFn = fs.readFileSync } = {}) {
  let raw;
  try {
    raw = readFileFn(mcpJsonPath, "utf8");
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

export function computeProxyEnv({ role, config, state }) {
  const active = computeActiveServers(config, state, role);
  const toolEnv = buildToolEnv(config, state, active);
  return {
    activeServers: [...active],
    toolEnv,
    proxyEnv: {
      ...toolEnv,
    },
  };
}
