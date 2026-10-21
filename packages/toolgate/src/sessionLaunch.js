// The session state of a launch (#19 T7): for an agent that honors `tools/list_changed`, one session file for the servers toolgate-proxy
// wraps, made at the first launch, kept by a relaunch with the conversation resumed, refreshed every hour while the agent runs, and
// removed when the agent ends with nothing pending. The agent and the proxies get its path in `TOOLGATE_SESSION_STATE`.
import fs from "node:fs";
import { computeActiveServers, computeActiveTools } from "./activeSet.js";
import { isProxied, namesItsServer } from "./proxied.js";
import { SAFE_SERVER } from "./catalog/sanitize.js";
import { printable } from "./assets/common.js";
import { SAFE_AGENT, cleanBaseline, createSession, plainPath, readSession, removeSession, sweepSessions, touchSession, updateSession } from "./session.js";

export const REFRESH_MS = 60 * 60 * 1000;

/**
 * The active servers whose entry in the project's .mcp.json runs through toolgate-proxy, each with the baseline the proxy is started
 * with (the list the adapter passes as its allowed tools; empty when the config sets none for the server).
 */
export function wrappedServers({ config, state, prompt, mcpJsonPath, readFileFn = fs.readFileSync }) {
  return wrappedActive({ config, state, prompt, mcpJsonPath, readFileFn }).map((server) => ({
    server,
    baseline: Object.hasOwn(config?.toolBaselines ?? {}, server) ? [...computeActiveTools(config, state, server)] : [],
  }));
}

/** The active servers whose entry in the project's .mcp.json runs through toolgate-proxy and sets TOOLGATE_SERVER to its own name, by name. */
export function wrappedActive({ config, state, prompt, mcpJsonPath, readFileFn = fs.readFileSync }) {
  let servers;
  try {
    servers = JSON.parse(readFileFn(mcpJsonPath, "utf8")).mcpServers;
  } catch {
    return [];
  }
  if (servers === null || typeof servers !== "object") return [];
  const wraps = (name) => {
    try {
      return Object.hasOwn(servers, name) && isProxied(servers[name]) && namesItsServer(servers[name], name);
    } catch {
      return false;
    }
  };
  return [...computeActiveServers(config, state, prompt)].filter(wraps).sort();
}

/**
 * The env for the agent: the session's path when there is one, and never one inherited from an outer toolgate otherwise (it would
 * point the inner agent's proxies at the outer session).
 */
export function launchEnv(sessionEnv, base = process.env) {
  const env = { ...base, ...sessionEnv };
  if (!sessionEnv) delete env.TOOLGATE_SESSION_STATE;
  return env;
}

const shown = (value) => printable(typeof value === "string" ? value : JSON.stringify(value)).slice(0, 40);
// What can go into the session: a server with a name that is not plain, or a baseline entry that is not a valid tool name, is left out
// of the file and said (the server and why), instead of voiding the session of every other server.
function cleanWrapped(wrapped, say) {
  const clean = [];
  for (const item of wrapped) {
    const { server, baseline = [] } = typeof item === "string" ? { server: item } : item;
    if (typeof server !== "string" || !SAFE_SERVER.test(server)) {
      say(`toolgate: the server ${shown(server)} has a name that is not a plain server name, so its tools are revealed only by a restart this session\n`);
      continue;
    }
    const { kept, dropped } = cleanBaseline(baseline);
    if (dropped.length) {
      const names = dropped.slice(0, 3).map((name) => `"${shown(name)}"`).join(", ");
      say(`toolgate: the baseline of ${server} has ${dropped.length} entries that are not valid tool names (letters, digits, _ . : -, up to 128 characters) or are past the limit of 1024: ${names}${dropped.length > 3 ? ", ..." : ""}; toolgate tools does not list them, but the proxy still offers them\n`);
    }
    clean.push({ server, baseline: kept });
  }
  return clean;
}

/**
 * @param {{ capability: object, agent: string, stderr: { write(s: string): void }, env?: Record<string, string|undefined>, intervalMs?: number, setIntervalFn?: Function, clearIntervalFn?: Function }} options
 */
export function sessionFor({ capability, agent, stderr, env = process.env, projectDir, intervalMs = REFRESH_MS, setIntervalFn = setInterval, clearIntervalFn = clearInterval, processRef = process }) {
  const options = { env };
  // A project folder that cannot be stored safely (a control character in its name, not normalized) is left out of the session; the
  // rest of the session stands, and the catalog card of its servers is not looked up.
  const storable = projectDir === undefined || plainPath(projectDir);
  // The adapter name, when it is one that can be stored: a name from the config with odd characters is left out, not refused.
  const creation = { env, projectDir: storable ? projectDir : undefined, agent: typeof agent === "string" && SAFE_AGENT.test(agent) ? agent : undefined };
  const dynamic = capability?.dynamicTools === true;
  let file = null;
  let noted = false;
  let saidFolder = false;
  // An agent that cannot start ends toolgate with an error that skips every `finally`: the file goes when the process does.
  const onExit = () => {
    if (file) removeSession(file, options);
  };
  const childEnv = () => ({ TOOLGATE_SESSION_STATE: file });
  return {
    /** Before a launch: the env to add for the agent (its session file), or null when there is none. `wrapped` is `[{ server, baseline }]`. */
    open(given) {
      // Nothing is said about a session an agent that does not take one will not have.
      const wrapped = cleanWrapped(given, dynamic ? (line) => stderr.write(line) : () => {});
      if (dynamic && !storable && wrapped.length && !saidFolder) {
        saidFolder = true;
        stderr.write(`toolgate: the project folder ${shown(projectDir)} cannot be stored in the session (control characters, or not a normalized path); the catalog cards of its servers are not looked up\n`);
      }
      if (file) {
        // A relaunch: the same file with exactly the servers the new active set wraps (one that is no longer wrapped goes, with what it
        // had revealed), the baselines the proxies start with now (what was revealed is kept), and alive again.
        const known = readSession(file, options);
        if (known) {
          const names = new Set(wrapped.map(({ server }) => server));
          const changed =
            Object.keys(known.servers).some((server) => !names.has(server)) ||
            wrapped.some(({ server, baseline }) => !Object.hasOwn(known.servers, server) || known.servers[server].baseline.join("\n") !== baseline.join("\n"));
          if (changed) {
            const written = updateSession(file, (state) => {
              const servers = {};
              for (const { server, baseline } of wrapped) servers[server] = { enabled: [], instructionsShown: false, ...state.servers[server], baseline };
              return { ...state, servers };
            }, options);
            if (written.refused) {
              // The file stays as it was and is still alive (a later launch can write it); the agent starts without a session this time.
              stderr.write(`${written.refused}\ntoolgate: the agent starts without a dynamic session this time; its tools are revealed only by a restart\n`);
              touchSession(file, options);
              return null;
            }
          }
          touchSession(file, options);
          return childEnv();
        }
        file = null;
      }
      if (wrapped.length === 0) return null;
      if (capability?.dynamicTools !== true) {
        if (!noted) stderr.write(`toolgate: ${agent} does not declare dynamicTools; tools are revealed only by a restart\n`);
        noted = true;
        return null;
      }
      sweepSessions(options);
      const made = createSession(wrapped, creation);
      if (made.refused) {
        stderr.write(`${made.refused}\n`);
        return null;
      }
      file = made.file;
      processRef.once("exit", onExit);
      return childEnv();
    },
    /** While the agent runs: the file is touched every hour. Returns the function that stops it. */
    watch() {
      if (!file) return () => {};
      const timer = setIntervalFn(() => touchSession(file, options), intervalMs);
      timer.unref?.();
      return () => clearIntervalFn(timer);
    },
    /** The launch is over. A restart still pending keeps the file for the sweep; otherwise it goes with its instructions files. */
    close({ pending = false } = {}) {
      if (!file) return;
      // The launch is over either way: the exit hook goes, and a pending restart keeps the file past this process too.
      processRef.removeListener("exit", onExit);
      if (!pending) removeSession(file, options);
    },
  };
}
