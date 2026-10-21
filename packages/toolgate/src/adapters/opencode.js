import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeActiveServers } from "../activeSet.js";
import { collectInstalled } from "../installed.js";
import { buildToolEnv, launchStdio, projectRuleFile, readServerNames, toEnvVarName } from "./shared.js";
import { linkInPath, sweepAgentFiles, writeAgentFiles } from "../subagents/register.js";
import { COMMANDS_CAPABILITY } from "./commands.js";
import { HOOKS_CAPABILITY, PERMISSIONS_CAPABILITY } from "./applying.js";
import { SUBAGENTS_CAPABILITY } from "./subagents.js";

export { buildToolEnv, toEnvVarName };

// opencode loads tool schemas at launch (LAUNCHED class). `OPENCODE_CONFIG` points it at a config
// file, so each launch gets a temp one with exactly the active servers. Rules location, resume, whether
// the config replaces or merges with the user's, and tools/list_changed support are not verified.
export const capability = Object.freeze({
  commands: COMMANDS_CAPABILITY["opencode"],
  subagents: SUBAGENTS_CAPABILITY["opencode"],
  hooks: HOOKS_CAPABILITY["opencode"],
  permissions: PERMISSIONS_CAPABILITY["opencode"],
  defersToolSchemas: false,
  rules: Object.freeze({ kind: "projectFile", path: "AGENTS.md" }),
  launchGating: "configFile",
  exclusiveMcpConfig: "unknown",
  resume: Object.freeze({ supported: "unknown" }),
  dynamicTools: "unknown",
  passthrough: "args",
});
export const supportsResume = false;

export function applyServers(active, toolEnv = {}) {
  return { configJson: buildConfigJson([...active], toolEnv) };
}

// Where the Step 0 rule goes for this agent, from its `rules` capability.
export function installDiscovery(ctx) {
  return projectRuleFile(capability, ctx);
}

function parseServers(raw) {
  return Object.keys(JSON.parse(raw).mcp ?? {});
}

export function readServers(configPath, { readFileFn = fs.readFileSync } = {}) {
  return readServerNames(configPath, parseServers, readFileFn);
}

export function installedServers({ cwd = process.cwd(), homedir = os.homedir(), readFileFn = fs.readFileSync } = {}) {
  return collectInstalled(
    [
      { path: path.join(homedir, ".config", "opencode", "opencode.json"), parse: parseServers },
      { path: path.join(cwd, "opencode.json"), parse: parseServers },
    ],
    { readFileFn },
  );
}

export function buildConfigJson(activeServers, toolEnv) {
  const mcp = {};
  for (const server of [...activeServers].sort()) {
    const envVarName = toEnvVarName(server);
    mcp[server] = toolEnv[envVarName] ? { environment: { [envVarName]: toolEnv[envVarName] } } : {};
  }
  return JSON.stringify({ mcp }, null, 2);
}

export function launch({
  prompt,
  headless = false,
  quiet = false,
  agentArgs = [],
  config,
  state,
  subagents = [],
  applied,
  projectDir = process.cwd(),
  stderr = process.stderr,
  env = process.env,
  spawnFn = spawn,
  writeFileFn = fs.writeFileSync,
  tmpDir = os.tmpdir(),
  opencodeBin = "opencode",
  pid = process.pid,
  now = Date.now(),
} = {}) {
  const active = computeActiveServers(config, state, prompt);
  const toolEnv = buildToolEnv(config, state, active);

  const configDir = path.join(tmpDir, `toolgate-opencode-${pid}-${now}`);
  const resolvedConfigPath = path.join(configDir, "opencode.json");
  const configJson = buildConfigJson([...active], toolEnv);
  fs.mkdirSync(configDir, { recursive: true });
  writeFileFn(resolvedConfigPath, configJson);

  // The active subagents are files in the folder opencode reads, marked as toolgate's and removed when the session
  // ends; the ones a dead session left behind are removed first. A file of the user's is never touched.
  const agentsDir = path.join(projectDir, capability.subagents.dir);
  // Nothing is read, written or removed through a link: the folder of the subagents has to be a real one inside the project.
  const linked = linkInPath(projectDir, capability.subagents.dir);
  if (linked && subagents.length) stderr.write(`toolgate: subagents were not registered: ${linked} is a symlink or not a folder, and nothing is written through it\n`);
  if (!linked) sweepAgentFiles({ dir: agentsDir });
  const registered = subagents.length && !linked ? writeAgentFiles({ dir: agentsDir, definitions: subagents }) : { written: [], skipped: [], remove: () => {} };
  for (const { name, reason } of registered.skipped) stderr.write(`toolgate: subagent ${name} was not registered: ${reason}\n`);

  // `opencode run <prompt>` is the non-interactive form; `--prompt` only seeds the interactive one.
  const args = [...(headless && prompt ? ["run"] : []), ...agentArgs, ...(prompt ? (headless ? [prompt] : ["--prompt", prompt]) : [])];
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn(opencodeBin, args, {
        env: { ...env, ...toolEnv, ...(applied?.env ?? {}), OPENCODE_CONFIG: resolvedConfigPath },
        stdio: launchStdio(quiet),
      });
    } catch (error) {
      // An agent that cannot be run at all (not a program) throws here, before the listener that cleans up exists.
      try {
        registered.remove();
      } catch {
        // the reason the agent did not start is the one to report, not a failure of the cleanup
      }
      throw error;
    }
    child.on("error", (error) => {
      try {
        registered.remove();
      } catch {
        // the reason the agent did not start is the one to report, not a failure of the cleanup
      }
      reject(error);
    });
    child.on("exit", (code, signal) => {
      registered.remove();
      resolve({ code, signal, resolvedConfigPath, configJson, subagents: registered.written, subagentsSkipped: registered.skipped });
    });
  });
}
