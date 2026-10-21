// `toolgate doctor [--json]`: diagnoses a toolgate setup. Findings are `ok`, `warn` or `error`;
// only errors make the exit code 1.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configLayerPaths, resolveConfig } from "../config.js";
import { daemonStatus, defaultExec } from "../daemon.js";
import {
  checkAgents,
  checkConfig,
  checkDaemon,
  checkMcp,
  checkNaming,
  checkQmd,
  checkRule,
  checkCommands,
  checkSubagents,
  checkHooks,
  checkGuardsOff,
  checkCatalog,
  checkIgnored,
  checkPermissions,
  checkSkills,
  checkStrayPins,
  checkClaudeSettings,
  checkOpencodeConfig,
  checkUserServers,
  readJsonFile,
} from "./checks.js";

const CHECKS = [
  ["agents", checkAgents],
  ["qmd.installed", checkQmd],
  ["daemon.reachable", checkDaemon],
  ["config.layers", checkConfig],
  ["rule.step0", checkRule],
  ["mcp.baseline", checkMcp],
  ["mcp.strayPins", checkStrayPins],
  ["mcp.userLevel", checkUserServers],
  ["naming.denylist", checkNaming],
  ["skills", checkSkills],
  ["commands", checkCommands],
  ["subagents", checkSubagents],
  ["hooks", checkHooks],
  ["claude.guardsOff", checkGuardsOff],
  ["claude.settings", checkClaudeSettings],
  ["opencode.config", checkOpencodeConfig],
  ["catalog", checkCatalog],
  ["config", checkIgnored],
  ["permissions", checkPermissions],
];

const MARKS = { ok: "ok   ", warn: "warn ", error: "error" };

export function formatReport({ summary, checks }) {
  const lines = checks.map((c) => `${MARKS[c.level]} ${c.id}: ${c.message}${c.hint ? `\n       -> ${c.hint}` : ""}`);
  lines.push("", `${summary.error} error${summary.error === 1 ? "" : "s"}, ${summary.warn} warning${summary.warn === 1 ? "" : "s"}, ${summary.ok} ok`);
  return `${lines.join("\n")}\n`;
}

const fileSize = (file) => {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
};

/**
 * @returns {Promise<number>} process exit code: 1 when any check reports an error
 */
export async function runDoctor({
  cwd,
  env = process.env,
  homedir = os.homedir(),
  json = false,
  stdout,
  execFn = defaultExec,
  daemon = { status: daemonStatus },
  fetchFn,
  registry,
}) {
  const { config, errors } = resolveConfig(configLayerPaths({ cwd, env, homedir }));
  const mcp = readJsonFile(path.join(cwd, ".mcp.json"));
  const ctx = {
    cwd,
    env,
    homedir,
    execFn,
    daemon,
    fetchFn,
    config,
    configErrors: errors,
    registry,
    mcpServers: mcp.value ? (mcp.value.mcpServers ?? {}) : null,
    mcpInvalid: mcp.invalid,
    mcpBytes: fileSize(path.join(cwd, ".mcp.json")),
    agents: [],
  };

  // In order: later checks read what earlier ones left on the context (`qmd`, `agents`).
  const checks = [];
  for (const [id, check] of CHECKS) {
    try {
      checks.push(...(await check(ctx)));
    } catch (err) {
      checks.push({ id, level: "error", message: `the check failed: ${err.message}` });
    }
  }

  const summary = { ok: 0, warn: 0, error: 0 };
  for (const check of checks) summary[check.level]++;
  const report = {
    ok: summary.error === 0,
    summary,
    checks,
    agents: ctx.agents.map(({ name, tier, raise }) => ({ name, tier, raise })),
  };

  stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
  return report.ok ? 0 : 1;
}
