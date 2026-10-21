import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeActiveServers } from "../activeSet.js";
import { collectInstalled } from "../installed.js";
import { parseJsonc } from "../jsonc.js";
import { MAX_MCP_BYTES } from "../proxyEnv.js";
import { buildToolEnv, launchStdio, projectRuleFile, readServerNames, toEnvVarName } from "./shared.js";
import { linkInPath, sweepAgentFiles, writeAgentFiles } from "../subagents/register.js";
import { COMMANDS_CAPABILITY } from "./commands.js";
import { HOOKS_CAPABILITY, PERMISSIONS_CAPABILITY } from "./applying.js";
import { SUBAGENTS_CAPABILITY } from "./subagents.js";

export { buildToolEnv, toEnvVarName };

// opencode loads tool schemas at launch (LAUNCHED class). `OPENCODE_CONFIG` points it at a config
// file, so each launch gets a temp one with exactly the active servers. Rules location, resume and whether
// the config replaces or merges with the user's are not verified. `dynamicTools` is: verified live with opencode 1.18.4, a tool
// enabled mid-session was called in the same run, and a local server inherits opencode's env (the session path reaches it).
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
  dynamicTools: true,
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

// A config file as text, or null: never through a symbolic link, only a regular file, and not past the size toolgate reads in other MCP files.
function readConfigFile(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(fd);
    return stat.isFile() && stat.size <= MAX_MCP_BYTES ? fs.readFileSync(fd, "utf8") : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// `mcp.<n>` as `{ command, args, env }`: a local server whose `command` is a list of words. Any other form is not recognized (null).
function localServer(entry) {
  if (!isObject(entry) || entry.type !== "local" || !Array.isArray(entry.command) || entry.command.length === 0) return null;
  if (!entry.command.every((word) => typeof word === "string")) return null;
  const [command, ...args] = entry.command;
  const env = isObject(entry.environment) ? Object.fromEntries(Object.entries(entry.environment).filter(([, value]) => typeof value === "string")) : {};
  return { command, args, env };
}

/**
 * The config files opencode reads for a launch, lowest priority first (the order is measured: see `definedServers`): the global
 * `opencode.json(c)` in `$XDG_CONFIG_HOME/opencode` (`~/.config/opencode` when it is unset or relative), the file `OPENCODE_CONFIG` names,
 * the project's, and `~/.opencode`. In each folder `opencode.json`, then `opencode.jsonc`.
 */
export function configFiles({ cwd = process.cwd(), homedir = os.homedir(), env = process.env } = {}) {
  const config = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(homedir, ".config");
  const both = (dir) => [path.join(dir, "opencode.json"), path.join(dir, "opencode.jsonc")];
  return [...both(path.join(config, "opencode")), ...(env.OPENCODE_CONFIG ? [path.resolve(cwd, env.OPENCODE_CONFIG)] : []), ...both(cwd), ...both(path.join(homedir, ".opencode"))];
}

/** The config files that are symbolic links: `definedServers` never follows one, so what they define is not seen. */
export function linkedConfigFiles(options) {
  return configFiles(options).filter((file) => {
    try {
      return fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink() === true;
    } catch {
      return false;
    }
  });
}

/**
 * The local servers opencode's config defines for a launch, `{ name: { command, args, env } }`. opencode merges the files it reads, the
 * later one winning. The order was measured live with opencode 1.18.4 (the same server under a different label at each level, the winner
 * removed on each run), lowest priority first: the global `opencode.json(c)` in `$XDG_CONFIG_HOME/opencode` (`~/.config/opencode`), the file
 * `OPENCODE_CONFIG` names, the project's, and `~/.opencode`, which wins over all of them. A server is taken whole from the last file that
 * names it, and an entry there that is not a local server with a `command` list removes the earlier one. A file that is a link, not a
 * regular file, too big or not valid JSONC is skipped.
 * Not verified, so not done: whether a later level that defines only part of a server (say only `environment`) merges key by key with the
 * earlier one or replaces it (taking it whole is the safe reading: a server that is not well formed is not read); `.opencode/opencode.json`
 * inside the project; the climb of folders up to the git root.
 */
export function definedServers(options = {}) {
  const servers = new Map();
  for (const file of configFiles(options)) {
    const text = readConfigFile(file);
    if (text === null) continue;
    let mcp;
    try {
      mcp = parseJsonc(text)?.mcp;
    } catch {
      continue;
    }
    if (!isObject(mcp)) continue;
    for (const [name, entry] of Object.entries(mcp)) {
      const server = localServer(entry);
      if (server) servers.set(name, server);
      else servers.delete(name);
    }
  }
  return Object.fromEntries(servers);
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
