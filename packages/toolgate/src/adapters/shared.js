import fs from "node:fs";
import path from "node:path";
import { computeActiveTools } from "../activeSet.js";

// Helpers every adapter that hands the per-server tool allow-list to the proxies through the
// environment shares.
export function toEnvVarName(server) {
  return `TOOLGATE_${server.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}_TOOLS`;
}

export function buildToolEnv(config, state, active) {
  const env = {};
  for (const server of Object.keys(config.toolBaselines ?? {})) {
    if (!active.has(server)) continue;
    env[toEnvVarName(server)] = [...computeActiveTools(config, state, server)].join(",");
  }
  return env;
}

// Server names in a config file; a missing or malformed file has none.
export function readServerNames(configPath, parse, readFileFn = fs.readFileSync) {
  try {
    return parse(readFileFn(configPath, "utf8"));
  } catch {
    return [];
  }
}
// Where the Step 0 rule goes for an agent whose `rules` capability is a project file.
export function projectRuleFile(capability, { cwd = process.cwd(), template = "" } = {}) {
  return { file: path.join(cwd, capability.rules.path), content: template };
}

/**
 * The stdio an agent is spawned with: its own terminal, except that --quiet drops what it prints to stdout (the result
 * of a non-interactive run). Its stderr and the notes toolgate prints stay.
 */
export function launchStdio(quiet) {
  return quiet ? ["inherit", "ignore", "inherit"] : "inherit";
}
