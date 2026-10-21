import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeActiveServers } from "../activeSet.js";
import { buildToolEnv, launchStdio, readServerNames, toEnvVarName } from "./shared.js";
import { COMMANDS_CAPABILITY } from "./commands.js";
import { HOOKS_CAPABILITY, PERMISSIONS_CAPABILITY } from "./applying.js";
import { SUBAGENTS_CAPABILITY } from "./subagents.js";

export { buildToolEnv, toEnvVarName };

// An adapter driven by declarative config, for agents with no dedicated one. The spec names the
// binary, the MCP config file toolgate writes (relative to a per-launch temp root), the env var
// that points the agent at that root, and the format:
//   { bin, configFile, homeEnv, format: "json" | "toml", serversKey | tablePrefix }
// Nothing else about the agent is assumed, so every other capability is "unknown".
export const capability = Object.freeze({
  commands: COMMANDS_CAPABILITY["generic"],
  subagents: SUBAGENTS_CAPABILITY["generic"],
  hooks: HOOKS_CAPABILITY["generic"],
  permissions: PERMISSIONS_CAPABILITY["generic"],
  defersToolSchemas: false,
  rules: Object.freeze({ kind: "unknown" }),
  launchGating: "configFile",
  exclusiveMcpConfig: "unknown",
  resume: Object.freeze({ supported: "unknown" }),
  dynamicTools: "unknown",
  passthrough: "args",
});
export const supportsResume = false;

export function validateSpec(spec) {
  const problems = [];
  if (!spec || typeof spec !== "object") return ["spec must be an object"];
  for (const field of ["bin", "configFile"]) {
    if (typeof spec[field] !== "string" || !spec[field]) problems.push(`spec.${field} is required`);
  }
  if (!["json", "toml"].includes(spec.format)) problems.push('spec.format must be "json" or "toml"');
  if (spec.homeEnv !== undefined && (typeof spec.homeEnv !== "string" || !spec.homeEnv)) {
    problems.push("spec.homeEnv must be a non-empty string");
  }
  return problems;
}

// TOML keys are bare only for [A-Za-z0-9_-]; anything else (dots, quotes) is quoted and escaped.
const tomlKey = (key) => (/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key));

/** The config text for `active` in the spec's format. */
export function buildConfig(spec, activeServers, toolEnv = {}) {
  const servers = [...activeServers].sort();
  if (spec.format === "toml") {
    const prefix = spec.tablePrefix ?? "mcp_servers";
    return servers
      .map((server) => {
        const table = `${prefix}.${tomlKey(server)}`;
        const lines = [`[${table}]`];
        const name = toEnvVarName(server);
        if (toolEnv[name]) lines.push(`[${table}.env]`, `${name} = ${JSON.stringify(toolEnv[name])}`);
        return lines.join("\n");
      })
      .join("\n\n");
  }
  const entries = {};
  for (const server of servers) {
    const name = toEnvVarName(server);
    entries[server] = toolEnv[name] ? { env: { [name]: toolEnv[name] } } : {};
  }
  return JSON.stringify({ [spec.serversKey ?? "mcpServers"]: entries }, null, 2);
}

export function parseServers(spec, raw) {
  if (spec.format === "toml") {
    const prefix = (spec.tablePrefix ?? "mcp_servers").replace(/\./g, "\\.");
    const pattern = new RegExp(`^\\[${prefix}\\.("(?:[^"\\\\]|\\\\.)*"|[A-Za-z0-9_-]+)\\]$`);
    return raw.split("\n").flatMap((line) => {
      const key = pattern.exec(line.trim())?.[1];
      return key === undefined ? [] : [key.startsWith('"') ? JSON.parse(key) : key];
    });
  }
  return Object.keys(JSON.parse(raw)[spec.serversKey ?? "mcpServers"] ?? {});
}

export function readServers(configPath, { spec, readFileFn = fs.readFileSync } = {}) {
  return readServerNames(configPath, (raw) => parseServers(spec ?? { format: "json" }, raw), readFileFn);
}

export function applyServers(active, toolEnv = {}, spec = { format: "json" }) {
  return { config: buildConfig(spec, [...active], toolEnv) };
}

export function installDiscovery() {
  return null;
}

export function launch({
  spec,
  prompt,
  quiet = false,
  config,
  state,
  env = process.env,
  spawnFn = spawn,
  writeFileFn = fs.writeFileSync,
  mkdirFn = fs.mkdirSync,
  tmpDir = os.tmpdir(),
  pid = process.pid,
  now = Date.now(),
} = {}) {
  const problems = validateSpec(spec);
  if (problems.length) return Promise.reject(new Error(`Invalid generic adapter spec: ${problems.join("; ")}`));
  const active = computeActiveServers(config, state, prompt);
  const toolEnv = buildToolEnv(config, state, active);

  const root = path.join(tmpDir, `toolgate-generic-${pid}-${now}`);
  const resolvedConfigPath = path.join(root, spec.configFile);
  const configText = buildConfig(spec, [...active], toolEnv);
  mkdirFn(path.dirname(resolvedConfigPath), { recursive: true });
  writeFileFn(resolvedConfigPath, configText);

  const childEnv = { ...env, ...toolEnv, ...(spec.homeEnv ? { [spec.homeEnv]: root } : {}) };
  return new Promise((resolve, reject) => {
    const child = spawnFn(spec.bin, prompt ? [prompt] : [], { env: childEnv, stdio: launchStdio(quiet) });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal, resolvedConfigPath, configText }));
  });
}

/** An adapter module bound to one spec, for agents declared in config. */
export function createGenericAdapter(spec) {
  const problems = validateSpec(spec);
  if (problems.length) throw new Error(`Invalid generic adapter spec: ${problems.join("; ")}`);
  return Object.freeze({
    capability,
    supportsResume,
    buildToolEnv,
    installDiscovery,
    readServers: (configPath, options = {}) => readServers(configPath, { ...options, spec }),
    applyServers: (active, toolEnv) => applyServers(active, toolEnv, spec),
    launch: (options = {}) => launch({ ...options, spec }),
  });
}
